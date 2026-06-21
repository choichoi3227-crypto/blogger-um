/**
 * worker.js — Blogspot Ultimate SEO Edge Worker (God Tier v7 + WASM)
 * ====================================================================
 * v6 → v7 변경점
 *  - WasmHasher        : sha256Hex → WasmHasher.sha256 (WebCrypto 통일)
 *  - WasmCompressor    : KV 저장 payload를 Gzip+Base64로 최소화
 *                        응답 Accept-Encoding 협상 자동 압축
 *  - WasmJsonParser    : 피드 JSON 파싱 가속 (simdjson-wasm / V8 폴백)
 *  - WasmDataProcessor : HTML 링크 재작성 배치 처리, 피드 entry 정규화
 *  - WasmCdnOptimizer  : Cache-Control, Surrogate-Key, ETag 자동 생성
 *  - warmupWasm()      : fetch 첫 요청 전 WASM 모듈 워밍업
 *  - 모든 기존 FIX(1~12) 그대로 유지
 */

import {
  WasmHasher,
  WasmCompressor,
  WasmJsonParser,
  WasmImageProcessor,
  WasmCdnOptimizer,
  WasmDataProcessor,
  warmupWasm
} from './wasm-utils.js';

// ---------------------------------------------------------------
// 상수
// ---------------------------------------------------------------
const FEED_CACHE_TTL_MS          = 1000 * 60 * 30;
const ORIGINAL_POST_PATH_RE      = /^\/\d{4}\/\d{2}\/[^/]+\.html$/;
// [FIX-17] CSS/JS는 사이트 동작에 직결되는 핵심 리소스이므로 jsDelivr CDN
// 오프로딩(=308 리디렉션) 대상에서 제외한다. 기존에는 css/js가 포함되어 있어
// 테마 스타일시트·스크립트가 GitHub 업로드 큐를 거쳐 jsDelivr URL로
// 리디렉션되었는데, jsDelivr 전파 지연·실패 시 사이트 전체가 스타일이
// 깨진 채로 표시되는 원인이 되었다. 이미지/폰트/미디어만 CDN 오프로딩
// 대상으로 남기고, CSS/JS는 원본(same-origin)에서 그대로 서빙한다.
const MEDIA_EXT_RE               = /\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|pdf|woff2?|ttf)(\?.*)?$/i;
const MAX_MEDIA_LOOKUPS_PER_REQUEST = 12;
const MAX_UPLOADS_PER_RUN        = 20;
const SLUG_REVIEW_INTERVAL_MS    = 1000 * 60 * 60 * 24 * 180;
const MAX_SLUG_REVIEWS_PER_RUN   = 30;

// ---------------------------------------------------------------
// V8 Isolate 메모리 캐시
// ---------------------------------------------------------------
let memFeedCache = { slugToPath: null, pathToSlug: null, updatedMap: null, fetchedAt: 0 };
const memSlugLookupCache = new Map();
const SLUG_LOOKUP_MEMO_MS = 1000 * 60 * 5;

// [FIX-8] 인플라이트 락
let _feedRefreshInflight = null;
// WASM 워밍업 Promise (isolate 당 1회)
let _wasmWarmupDone = false;
let _wasmWarmupPromise = null;

// ---------------------------------------------------------------
// 공통 유틸
// ---------------------------------------------------------------
function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// [FIX-5] stringToBase64 → WasmHasher / WasmCompressor로 위임
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

function stringToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return arrayBufferToBase64(bytes.buffer);
}

// [FIX-2] HTML 속성값 이스케이프
function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeStaticAssetKey(absoluteUrl) {
  try { const u = new URL(absoluteUrl); return `${u.origin}${u.pathname}`; }
  catch { return absoluteUrl; }
}

async function runIsolatedStage(stageName, input, stageReport, fn, fallbackValue) {
  try {
    const result = await fn(input);
    stageReport.ok.push(stageName);
    return result;
  } catch (e) {
    console.error(`[SSR isolated stage failed] ${stageName}:`, e);
    stageReport.failed.push(stageName);
    return fallbackValue !== undefined ? fallbackValue : input;
  }
}

async function runDetachedTask(taskName, taskFn) {
  try { await taskFn(); }
  catch (e) { console.error(`[detached task failed] ${taskName}:`, e); }
}

// ---------------------------------------------------------------
// WASM 워밍업 (isolate 당 1회 — 첫 요청 시 비동기 트리거)
// ---------------------------------------------------------------
function ensureWasmWarm(ctx) {
  if (_wasmWarmupDone) return;
  if (_wasmWarmupPromise) { ctx?.waitUntil(_wasmWarmupPromise); return; }
  _wasmWarmupPromise = warmupWasm().then(() => { _wasmWarmupDone = true; });
  ctx?.waitUntil(_wasmWarmupPromise);
}

// ---------------------------------------------------------------
// GitHub API 래퍼
// ---------------------------------------------------------------
async function githubPutFile(env, repoPath, content, commitMessage, isBase64 = false) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO)
    throw new Error('GitHub 환경변수(GITHUB_TOKEN/OWNER/REPO)가 설정되지 않았습니다.');

  const branch    = GITHUB_BRANCH || 'main';
  const apiUrl    = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`;
  const commonHeaders = {
    'Authorization'       : `Bearer ${GITHUB_TOKEN}`,
    'Accept'              : 'application/vnd.github+json',
    'User-Agent'          : 'blogspot-edge-worker',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let existingSha = null;
  try {
    const r = await fetch(`${apiUrl}?ref=${branch}`, { headers: commonHeaders });
    if (r.ok) existingSha = (await r.json()).sha || null;
  } catch {}

  let base64Content;
  if (isBase64)                       base64Content = content;
  else if (typeof content === 'string') base64Content = stringToBase64(content);
  else                                base64Content = arrayBufferToBase64(content);

  const putBody = { message: commitMessage, content: base64Content, branch };
  if (existingSha) putBody.sha = existingSha;

  const putRes = await fetch(apiUrl, {
    method : 'PUT',
    headers: { ...commonHeaders, 'Content-Type': 'application/json' },
    body   : JSON.stringify(putBody)
  });
  if (!putRes.ok) {
    const err = await putRes.text().catch(() => '');
    throw new Error(`GitHub commit 실패 (${putRes.status}): ${err.substring(0, 300)}`);
  }
  return putRes.json();
}

function buildJsDelivrUrl(env, repoPath) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  return `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH || 'main'}/${repoPath}`;
}

async function purgeJsDelivr(env, repoPath) {
  try {
    const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
    await fetch(`https://purge.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH || 'main'}/${repoPath}`);
  } catch {}
}

async function buildMediaRepoPath(originalUrl) {
  let ext = 'bin';
  try { ext = (new URL(originalUrl).pathname.match(MEDIA_EXT_RE) || [, 'bin'])[1] || 'bin'; } catch {}
  // [WASM] WasmHasher.sha256 사용
  const hash  = await WasmHasher.sha256(originalUrl);
  const shard = hash.substring(0, 2);
  return `media/${shard}/${hash}.${ext}`;
}

// ---------------------------------------------------------------
// 미디어 오프로드 — MEDIA_KV
// ---------------------------------------------------------------
async function resolveMediaUrl(env, originalUrl) {
  if (!env.MEDIA_KV) return null;
  // [FIX-17 guard] 과거 버그로 큐에 이미 들어간 CSS/JS 항목이 있더라도
  // 절대 jsDelivr로 리디렉션하지 않는다 (사이트 깨짐 재발 방지).
  if (/\.(css|js)(\?.*)?$/i.test(originalUrl)) return null;
  try {
    const normalized = normalizeStaticAssetKey(originalUrl);
    const hash       = await WasmHasher.sha256(normalized);  // [WASM]
    const key        = `media:${hash}`;
    const existingRaw = await env.MEDIA_KV.get(key);

    if (existingRaw) {
      const record = safeJsonParse(existingRaw, null);
      if (record?.status === 'done' && record.jsdelivrUrl) return record.jsdelivrUrl;
      return null;
    }
    await env.MEDIA_KV.put(key, JSON.stringify({ originalUrl: normalized, status: 'pending', queuedAt: Date.now() }));
    return null;
  } catch { return null; }
}

async function mapInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

async function rewriteMediaToJsDelivr(html, origin, env) {
  if (!env.MEDIA_KV) return html;
  const candidates = new Map();
  let m;
  const re1 = /(src|href)=(["'])([^"']+)\2/gi;
  while ((m = re1.exec(html)) !== null) {
    if (!MEDIA_EXT_RE.test(m[3])) continue;
    let abs;
    try { abs = new URL(m[3], origin).toString(); } catch { continue; }
    candidates.set(abs, true);
  }
  if (candidates.size === 0) return html;

  const urlList  = Array.from(candidates.keys()).slice(0, MAX_MEDIA_LOOKUPS_PER_REQUEST);
  const resolved = await mapInBatches(urlList, 4, u => resolveMediaUrl(env, u));

  const urlMap = new Map();
  urlList.forEach((u, i) => { if (resolved[i]) urlMap.set(u, resolved[i]); });
  if (urlMap.size === 0) return html;

  return html.replace(/(src|href)=(["'])([^"']+)\2/gi, (full, attr, quote, value) => {
    let abs;
    try { abs = new URL(value, origin).toString(); } catch { return full; }
    const cdn = urlMap.get(abs);
    return cdn ? `${attr}=${quote}${cdn}${quote}` : full;
  });
}

// ---------------------------------------------------------------
// 슬러그 매핑 — SLUG_KV
// ---------------------------------------------------------------
function titleToSlug(title) {
  return title.trim().toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// [FIX-8] 인플라이트 락
async function refreshSlugMaps(origin, env, { force = false } = {}) {
  const now = Date.now();
  if (!force && memFeedCache.slugToPath && (now - memFeedCache.fetchedAt < FEED_CACHE_TTL_MS))
    return memFeedCache;

  if (_feedRefreshInflight) {
    try { return await _feedRefreshInflight; } catch {}
  }
  _feedRefreshInflight = _doRefreshSlugMaps(origin, env, now);
  try { return await _feedRefreshInflight; }
  finally { _feedRefreshInflight = null; }
}

async function _doRefreshSlugMaps(origin, env, now) {
  const feedUrl = `${origin}/feeds/posts/default?alt=json&max-results=500`;
  let feedJson;
  try {
    const res = await fetch(feedUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`feed http ${res.status}`);
    // [WASM] WasmJsonParser로 피드 파싱 가속
    const text = await res.text();
    feedJson   = await WasmJsonParser.parse(text);
  } catch {
    if (memFeedCache.slugToPath) return memFeedCache;
    return { slugToPath: new Map(), pathToSlug: new Map(), updatedMap: new Map(), fetchedAt: now };
  }

  // [WASM] WasmDataProcessor로 entry 정규화 배치 처리 + [FIX-6]
  const rawEntries  = feedJson?.feed?.entry;
  const normalizedEntries = WasmDataProcessor.normalizeFeedEntries(rawEntries);

  const newSlugToPath = new Map();
  const newPathToSlug = new Map();
  const newUpdatedMap = new Map();
  const changedPaths  = [];
  const prevUpdatedMap = memFeedCache.updatedMap || new Map();

  for (const { title, updated, pathname } of normalizedEntries) {
    try {
      const slug = titleToSlug(title);
      if (!slug) continue;
      newSlugToPath.set(slug, pathname);
      newPathToSlug.set(pathname, slug);
      newUpdatedMap.set(pathname, updated);
      const prev = prevUpdatedMap.get(pathname);
      if (prev && prev !== updated) changedPaths.push(pathname);
    } catch (e) { console.error('[refreshSlugMaps] entry error:', e); }
  }

  memFeedCache = { slugToPath: newSlugToPath, pathToSlug: newPathToSlug, updatedMap: newUpdatedMap, fetchedAt: now };
  await persistSlugMapsToKV(env, memFeedCache, changedPaths);
  return memFeedCache;
}

async function persistSlugMapsToKV(env, mapsObj, changedPaths) {
  if (!env.SLUG_KV) return;
  try {
    await env.SLUG_KV.put('feedmeta', JSON.stringify({
      fetchedAt: mapsObj.fetchedAt, count: mapsObj.slugToPath.size,
      lastChanged: changedPaths, lastChangedAt: changedPaths.length ? Date.now() : null
    }));
    if (changedPaths.length) {
      await Promise.all(changedPaths.map(path => {
        const slug = mapsObj.pathToSlug.get(path);
        if (slug) return writeSlugMapping(env, path, slug, mapsObj.updatedMap.get(path));
      }).filter(Boolean));
    }
  } catch {}
}

// [FIX-12] [FIX-15] 슬러그가 바뀌면 이전 slug:* 키를 삭제해야 한다.
// 그렇지 않으면 옛 슬러그가 KV에 영구히 남아 메모리 캐시(최신 슬러그)와
// KV(낡은 슬러그)가 서로 다른 "currentSlug"를 반환하게 되고,
// 두 슬러그가 번갈아 리디렉션을 발생시키는 무한 루프로 이어질 수 있다.
async function writeSlugMapping(env, path, slug, updatedText) {
  if (!env.SLUG_KV) return;
  try {
    let createdAt = Date.now();
    const existingRaw = await env.SLUG_KV.get(`path:${path}`);
    const existing    = safeJsonParse(existingRaw, null);
    if (existing?.createdAt) createdAt = existing.createdAt;

    const ops = [
      env.SLUG_KV.put(`path:${path}`, JSON.stringify({ slug, updated: updatedText, createdAt })),
      env.SLUG_KV.put(`slug:${slug}`, path)
    ];
    // 이전 슬러그가 현재 슬러그와 다르면 옛 키 제거
    if (existing?.slug && existing.slug !== slug) {
      ops.push(env.SLUG_KV.delete(`slug:${existing.slug}`));
    }
    await Promise.all(ops);
  } catch (e) { console.error('[writeSlugMapping] KV write failed:', e); }
}

async function lookupPathForSlug(env, slug, origin) {
  if (memFeedCache.slugToPath?.has(slug)) return memFeedCache.slugToPath.get(slug);
  const memo = memSlugLookupCache.get(slug);
  if (memo?.expiresAt > Date.now()) return memo.path;
  if (env.SLUG_KV) {
    try {
      const path = await env.SLUG_KV.get(`slug:${slug}`);
      if (path) { memSlugLookupCache.set(slug, { path, expiresAt: Date.now() + SLUG_LOOKUP_MEMO_MS }); return path; }
    } catch {}
  }
  return null;
}

async function lookupSlugForPath(env, path) {
  if (memFeedCache.pathToSlug?.has(path)) return memFeedCache.pathToSlug.get(path);
  if (env.SLUG_KV) {
    try {
      const raw    = await env.SLUG_KV.get(`path:${path}`);
      const parsed = safeJsonParse(raw, null);
      if (parsed?.slug) return parsed.slug;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------
// [FIX-1] [FIX-16] [FIX-18] 리디렉션 안전 헬퍼
// 같은 경로로의 자기 리디렉션뿐 아니라, 슬러그 매핑이 꼬여 A→B→A 식으로
// 두 경로를 번갈아 리디렉션하는 다중 홉 루프도 차단해야 한다.
//
// [FIX-18] 기존에는 브라우저 Cookie 누적 카운터만으로 루프를 차단했는데,
// 검색엔진 크롤러·업타임 모니터·curl·소셜 미디어 미리보기 봇 등 Cookie를
// 저장/재전송하지 않는 클라이언트에서는 카운터가 절대 누적되지 않아
// 무한 리디렉션 루프가 그대로 재현되는 치명적 결함이 있었다.
// 이를 막기 위해 상태를 클라이언트 저장소(Cookie)가 아니라 리디렉션
// URL 자체(쿼리 파라미터)에 싣는 "stateless loop guard"를 1차 방어선으로
// 추가한다 — 어떤 클라이언트든 이 파라미터가 붙은 요청을 받으면 worker는
// 내부 슬러그 교정 리디렉션을 두 번 다시 수행하지 않고 콘텐츠를 그대로
// 서빙하므로, 최악의 경우에도 리디렉션은 정확히 1회로 끝난다.
// 기존 Cookie 카운터는 호환성을 위해 2차 방어선으로 유지한다.
// ---------------------------------------------------------------
const REDIRECT_LOOP_COOKIE = 'um_redir_chain';
const REDIRECT_LOOP_MAX    = 3;
const LOOP_GUARD_PARAM     = '_umr';

function isLoopGuarded(url) {
  return url.searchParams.has(LOOP_GUARD_PARAM);
}

function withLoopGuard(toUrl) {
  try {
    const u = new URL(toUrl);
    u.searchParams.set(LOOP_GUARD_PARAM, '1');
    return u.toString();
  } catch { return toUrl; }
}

function getRedirectChainCount(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/um_redir_chain=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function safeRedirect(fromUrl, toUrl, status = 301, request = null) {
  try {
    const from = new URL(fromUrl);
    const to   = new URL(toUrl);
    if (from.pathname + from.search === to.pathname + to.search) {
      console.warn('[safeRedirect] skipped self-redirect:', toUrl);
      return null;
    }
    // [FIX-18] 이미 한 번 worker 내부 리디렉션을 거쳐온 요청이면(=stateless
    // guard 파라미터 보유) 더 이상 리디렉션하지 않고 루프를 즉시 끊는다.
    if (isLoopGuarded(from)) {
      console.warn('[safeRedirect] loop-guarded request, aborting further redirect:', toUrl);
      return null;
    }
  } catch (e) { console.error('[safeRedirect] URL parse error:', e); return null; }

  // [FIX-18] 2차 방어선: Cookie 기반 카운터(쿠키를 지원하는 클라이언트용)
  const chainCount = request ? getRedirectChainCount(request) : 0;
  if (chainCount >= REDIRECT_LOOP_MAX) {
    console.error('[safeRedirect] loop threshold exceeded, aborting redirect:', toUrl);
    return null;
  }

  const guardedToUrl = withLoopGuard(toUrl);
  const headers = {
    'Location': guardedToUrl,
    'Cache-Control': 'no-store',
    'Set-Cookie': `${REDIRECT_LOOP_COOKIE}=${chainCount + 1}; Path=/; Max-Age=10; SameSite=Lax`
  };
  return new Response(null, { status, headers });
}

// ---------------------------------------------------------------
// Cache Reserve — KV (압축 저장 v7)
// ---------------------------------------------------------------
async function getFromCacheReserve(env, cacheKey) {
  if (!env.CACHE_RESERVE_KV) return null;
  try {
    const raw = await env.CACHE_RESERVE_KV.get(cacheKey);
    if (!raw) return null;
    // [WASM] 압축 패킹 v2 형식 감지
    try {
      const packed = JSON.parse(raw);
      if (packed?.v === 2) return WasmCompressor.unpackFromKv(packed);
    } catch {}
    return raw; // 구 버전(비압축) 그대로 반환
  } catch { return null; }
}

async function putToCacheReserve(env, cacheKey, html) {
  if (!env.CACHE_RESERVE_KV) return;
  try {
    // [WASM] Gzip 압축 후 저장 (페이로드 최소화)
    const packed = await WasmCompressor.packForKv(html);
    await env.CACHE_RESERVE_KV.put(cacheKey, JSON.stringify(packed));
  } catch {}
}

async function backupHtmlToGithub(env, cacheKey, html) {
  try {
    const repoPath = `cache/${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
    await githubPutFile(env, repoPath, html, `cache reserve: ${cacheKey}`);
  } catch {}
}

// ---------------------------------------------------------------
// 엣지 최적화 헤더
// ---------------------------------------------------------------
// [FIX-19] 치명적 버그: Cloudflare Workers는 fetch()로 보내는 Request에
// Accept-Encoding 헤더가 "명시적으로" 설정되어 있으면 origin 응답을 자동으로
// 압축 해제하지 않는다(Workers 런타임 동작). 기존 코드는 여기서 항상
// 'br, gzip'을 강제로 set() 했기 때문에, origin(Blogspot)이 gzip/br로 압축한
// 바이트가 압축 해제되지 않은 채 그대로 들어왔고, 이를 performEdgeSideRendering()
// 에서 response.text()로 읽으면서 압축 바이트가 깨진 문자(mojibake)로 렌더링
// 되었다 — 사용자가 신고한 "라우트 도메인에서 글자가 깨져 보임" 현상의 근본 원인.
// 해결: 들어온 요청에서 복사되어 온 Accept-Encoding 헤더를 완전히 제거해
// Cloudflare의 기본 자동 압축 해제 동작이 정상적으로 적용되게 한다.
// (최종 클라이언트 응답의 압축은 fetch 핸들러 하단에서 WasmCompressor가
//  원 요청의 Accept-Encoding을 별도로 읽어 직접 처리하므로 영향 없음.)
function applyEdgeOptimizationHeaders(headers, isStaticAsset) {
  headers.delete('Accept-Encoding');
  if (isStaticAsset) headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return headers;
}

function getOptimalRegion(continent = 'NA', colo = 'UNKNOWN') {
  const r = { AS: 'aws-apnortheast2', NA: 'aws-useast1', EU: 'azure-westeurope', OC: 'aws-apsoutheast2', SA: 'aws-saeast1' };
  return r[continent] || `gcp-${colo}`;
}

// ---------------------------------------------------------------
// 메인 fetch 핸들러
// ---------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    // WASM 워밍업 (첫 요청 시 백그라운드)
    ensureWasmWarm(ctx);

    try {
      let url;
      try { url = new URL(request.url); }
      catch { return new Response('Bad Request', { status: 400 }); }

      // [FIX-9] http→https 즉시 반환
      if (url.protocol === 'http:')
        return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);

      let cleanUrl;
      try { cleanUrl = new URL(url.origin + url.pathname + url.search); }
      catch { cleanUrl = url; }

      // [FIX-18] 루프 가드 파라미터는 안전한 리디렉션 여부 판단(safeRedirect
      // 내부에서 request.url 기준으로 이미 확인됨)에만 쓰이고, 그 이후의
      // 캐시 키 / canonical URL / 재리디렉션 대상 URL 생성에는 절대 섞이면
      // 안 되므로 여기서 제거해 둔다.
      if (cleanUrl.searchParams.has(LOOP_GUARD_PARAM)) cleanUrl.searchParams.delete(LOOP_GUARD_PARAM);

      const decodedPath  = decodeURIComponent(cleanUrl.pathname);
      const isStaticAsset = MEDIA_EXT_RE.test(decodedPath);

      // ---- 정적 자산 ----
      if (isStaticAsset && env.MEDIA_KV) {
        const cdnUrl = await runIsolatedStage(
          'media_redirect_lookup', cleanUrl.toString(), { ok: [], failed: [] },
          s => resolveMediaUrl(env, s), null
        );
        // [FIX-10]
        if (cdnUrl && cdnUrl !== cleanUrl.toString()) {
          const redir = safeRedirect(request.url, cdnUrl, 308, request);
          if (redir) return redir;
        }
      }

      // ---- 슬러그 맵 워밍업 ----
      let maps;
      if (memFeedCache.slugToPath && (Date.now() - memFeedCache.fetchedAt < FEED_CACHE_TTL_MS)) {
        maps = memFeedCache;
        if (Date.now() - memFeedCache.fetchedAt > FEED_CACHE_TTL_MS / 2)
          ctx.waitUntil(runDetachedTask('slug_map_background_refresh', () => refreshSlugMaps(url.origin, env, { force: true })));
      } else {
        maps = await runIsolatedStage('slug_map_refresh', null, { ok: [], failed: [] },
          () => refreshSlugMaps(url.origin, env, { force: false }),
          { slugToPath: new Map(), pathToSlug: new Map(), updatedMap: new Map(), fetchedAt: 0 }
        );
      }

      // ---- 라우팅 결정 ----
      let targetPath, canonicalUrl, isCustomSlug = false;

      if (ORIGINAL_POST_PATH_RE.test(decodedPath)) {
        const seoSlug = await runIsolatedStage('slug_lookup_for_path', decodedPath, { ok: [], failed: [] },
          p => lookupSlugForPath(env, p), null);
        if (seoSlug) {
          const redirectUrl = `${url.origin}/${seoSlug}${cleanUrl.search}`;
          let slugPath = '';
          try { slugPath = new URL(redirectUrl).pathname; } catch {}
          if (ORIGINAL_POST_PATH_RE.test(slugPath)) {
            targetPath   = decodedPath;
            canonicalUrl = `${url.origin}${decodedPath}`;
          } else {
            const redir = safeRedirect(request.url, redirectUrl, 301, request);
            if (redir) return redir;
            targetPath   = decodedPath;
            canonicalUrl = `${url.origin}${decodedPath}`;
          }
        } else {
          targetPath   = decodedPath;
          canonicalUrl = `${url.origin}${decodedPath}`;
          ctx.waitUntil(runDetachedTask('slug_map_force_refresh_unmapped', () => refreshSlugMaps(url.origin, env, { force: true })));
        }

      } else if (
        decodedPath !== '/' &&
        !decodedPath.includes('.') &&
        !decodedPath.match(/\/\d{4}\/\d{2}\//) &&
        !decodedPath.startsWith('/search')
      ) {
        isCustomSlug = true;
        const cleanSlug  = decodedPath.replace(/^\/|\/$/g, '');
        const mappedPath = await runIsolatedStage('slug_lookup', cleanSlug, { ok: [], failed: [] },
          s => lookupPathForSlug(env, s, url.origin), null);

        if (mappedPath) {
          const currentSlug = await runIsolatedStage('slug_lookup_current', mappedPath, { ok: [], failed: [] },
            p => lookupSlugForPath(env, p), cleanSlug);
          if (currentSlug && currentSlug !== cleanSlug) {
            const redirectUrl = `${url.origin}/${currentSlug}${cleanUrl.search}`;
            const redir = safeRedirect(request.url, redirectUrl, 301, request);
            if (redir) return redir;
          }
          targetPath   = mappedPath;
          canonicalUrl = `${url.origin}${decodedPath}`;
        } else {
          targetPath   = decodedPath;
          canonicalUrl = `${url.origin}${decodedPath}`;
          ctx.waitUntil(runDetachedTask('slug_map_force_refresh', () => refreshSlugMaps(url.origin, env, { force: true })));
        }
      } else {
        targetPath   = decodedPath;
        canonicalUrl = `${url.origin}${decodedPath}`;
      }

      const headers = applyEdgeOptimizationHeaders(new Headers(request.headers), isStaticAsset);
      headers.set('X-Custom-LB-Region', getOptimalRegion(request.cf?.continent, request.cf?.colo));

      let originUrl;
      try { originUrl = new URL(targetPath, cleanUrl.origin); }
      catch { return fetch(request); }

      const modifiedRequest  = new Request(originUrl, {
        headers,
        cf: { cacheTtl: 31536000, cacheEverything: true, ignoreQueryString: true }
      });
      const cacheKeyRequest  = new Request(cleanUrl.toString(), { headers, cf: { cacheTtl: 31536000, cacheEverything: true } });
      const reserveKey       = `html:${cleanUrl.pathname}${cleanUrl.search}`;
      const cache            = caches.default;

      let response = await cache.match(cacheKeyRequest);

      if (!response) {
        const reservedHtml = await getFromCacheReserve(env, reserveKey);
        if (reservedHtml) {
          response = new Response(reservedHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          ctx.waitUntil(runDetachedTask('edge_cache_restore', () => cache.put(cacheKeyRequest, response.clone())));
        }
      }

      if (!response) {
        const originResponse = await fetch(modifiedRequest);
        response = await performEdgeSideRendering(originResponse, canonicalUrl, isCustomSlug, url.origin, env, ctx);

        // [WASM] WasmCdnOptimizer로 Cache-Control 설정
        const cacheHeaders = await WasmCdnOptimizer.buildOptimalHeaders(
          cleanUrl.pathname,
          response.headers.get('content-type') || '',
          null,  // ETag는 별도 계산
          response.status
        );
        for (const [k, v] of Object.entries(cacheHeaders)) response.headers.set(k, v);
        response.headers.set('X-Content-Type-Options', 'nosniff');

        const htmlForReserve = await response.clone().text();
        ctx.waitUntil(runDetachedTask('edge_cache_put',  () => cache.put(cacheKeyRequest, response.clone())));
        ctx.waitUntil(runDetachedTask('cache_reserve_put', () => putToCacheReserve(env, reserveKey, htmlForReserve)));
        ctx.waitUntil(runDetachedTask('github_backup',   () => backupHtmlToGithub(env, reserveKey, htmlForReserve)));
      } else {
        ctx.waitUntil(runDetachedTask('background_revalidate', () =>
          updateCacheBackground(modifiedRequest, cacheKeyRequest, cache, canonicalUrl, isCustomSlug, url.origin, env, reserveKey)
        ));
      }

      response = new Response(response.body, response);
      response.headers.set('X-Edge-SSR', 'true');
      response.headers.set('X-Worker-Execution-Time', `${Date.now() - startTime}ms`);

      // [WASM] Accept-Encoding 협상 압축 (Edge 응답 자동 압축)
      const acceptEncoding = request.headers.get('Accept-Encoding') || '';
      const contentType    = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') && acceptEncoding) {
        try {
          const html = await response.clone().text();
          const { body: compressedBody, encoding } = await WasmCompressor.compressResponse(html, acceptEncoding);
          if (encoding) {
            const compressedHeaders = new Headers(response.headers);
            // [FIX] charset 보장 — 인코딩 깨짐 방지
            compressedHeaders.set('Content-Type', 'text/html; charset=utf-8');
            compressedHeaders.set('Content-Encoding', encoding);
            compressedHeaders.delete('Content-Length');
            return new Response(compressedBody, { status: response.status, headers: compressedHeaders });
          }
        } catch {}
      }
      // [FIX] 압축 없이 반환할 때도 charset 보장
      if (contentType.includes('text/html') && !contentType.includes('charset')) {
        response.headers.set('Content-Type', 'text/html; charset=utf-8');
      }

      return response;

    } catch (error) {
      console.error('Critical SSR Worker Exception:', error);
      try { return await fetch(request); }
      catch { return new Response('일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.', { status: 502 }); }
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDetachedTask('media_upload_queue', () => processMediaUploadQueue(env)));
    ctx.waitUntil(runDetachedTask('slug_periodic_review', () => reviewStaleSlugs(env)));
  }
};

// ---------------------------------------------------------------
// 슬러그 재검토
// ---------------------------------------------------------------
async function reviewStaleSlugs(env) {
  if (!env.SLUG_KV) return;
  if (!memFeedCache.pathToSlug?.size) return;
  const now = Date.now();
  let reviewed = 0, cursor;
  try {
    do {
      const listResult = await env.SLUG_KV.list({ prefix: 'path:', cursor, limit: 100 });
      for (const key of listResult.keys) {
        if (reviewed >= MAX_SLUG_REVIEWS_PER_RUN) break;
        try {
          const path   = key.name.slice('path:'.length);
          const raw    = await env.SLUG_KV.get(key.name);
          const record = safeJsonParse(raw, null);
          if (!record?.slug) continue;
          if (record.createdAt && (now - record.createdAt) < SLUG_REVIEW_INTERVAL_MS) continue;
          const recomputedSlug = memFeedCache.pathToSlug.get(path);
          if (!recomputedSlug) continue;
          reviewed++;
          if (recomputedSlug === record.slug) {
            await env.SLUG_KV.put(key.name, JSON.stringify({ ...record, createdAt: now }));
            continue;
          }
          await Promise.all([
            env.SLUG_KV.put(key.name, JSON.stringify({ slug: recomputedSlug, updated: record.updated, createdAt: now })),
            env.SLUG_KV.put(`slug:${recomputedSlug}`, path)
          ]);
          memFeedCache.pathToSlug.set(path, recomputedSlug);
          memFeedCache.slugToPath.set(recomputedSlug, path);
          memSlugLookupCache.delete(record.slug);
          memSlugLookupCache.set(recomputedSlug, { path, expiresAt: now + SLUG_LOOKUP_MEMO_MS });
        } catch (e) { console.error('[reviewStaleSlugs] item error:', key.name, e); }
      }
      cursor = listResult.cursor;
      if (reviewed >= MAX_SLUG_REVIEWS_PER_RUN) break;
    } while (cursor);
  } catch (e) { console.error('Slug periodic review error:', e); }
}

// ---------------------------------------------------------------
// SSR 렌더링 파이프라인
// ---------------------------------------------------------------
async function performEdgeSideRendering(response, canonicalUrl, isCustomSlug, origin, env, ctx) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return new Response(response.body, response);

  const stageReport = { ok: [], failed: [] };
  let html = await response.text();

  // [WASM] WasmDataProcessor.batchReplaceLinks (배치 최적화)
  html = await runIsolatedStage('internal_link_rewrite', html, stageReport,
    input => WasmDataProcessor.batchReplaceLinks(input, memFeedCache.pathToSlug, origin));

  html = await runIsolatedStage('media_jsdelivr_rewrite', html, stageReport,
    input => rewriteMediaToJsDelivr(input, origin, env));

  const faqs = await runIsolatedStage('faq_extraction', html, stageReport,
    input => extractFaqsFromHtml(input), []);

  const meta = await runIsolatedStage('meta_extraction', html, stageReport,
    input => extractTitleAndDescription(input), { title: 'Blogspot', descText: '' });

  const schemaScript = await runIsolatedStage('schema_assembly', { meta, faqs, canonicalUrl }, stageReport,
    input => buildSchemaScriptTag(input.meta, input.faqs, input.canonicalUrl), '');

  html = await runIsolatedStage('meta_tag_injection', html, stageReport,
    input => injectSeoTags(input, meta.descText, canonicalUrl, schemaScript), html);

  // [FIX-13] html은 이미 디코딩된 평문 텍스트이므로 원본의 Content-Encoding/
  // Content-Length 헤더를 그대로 복사하면 브라우저가 평문을 다시 압축 해제
  // 시도하다가 화면이 깨진다. 헤더를 복제한 뒤 인코딩 관련 헤더는 제거한다.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('Content-Encoding');
  responseHeaders.delete('Content-Length');
  const response2 = new Response(html, { headers: responseHeaders, status: response.status, statusText: response.statusText });
  // [FIX] charset 항상 명시 — 인코딩 깨짐 방지
  response2.headers.set('Content-Type', 'text/html; charset=utf-8');
  if (stageReport.failed.length) response2.headers.set('X-Edge-Stage-Failed', stageReport.failed.join(','));
  response2.headers.set('X-Edge-Stage-OK', stageReport.ok.join(','));
  return response2;
}

function extractTitleAndDescription(html) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title      = titleMatch ? titleMatch[1].trim() : 'Blogspot';
  const pMatch     = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  let descText     = '';
  if (pMatch) {
    descText = pMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').substring(0, 160).trim() + '...';
  }
  return { title, descText };
}

// [FIX-4]
function extractFaqsFromHtml(html) {
  const faqs         = [];
  const headingRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const hText = match[1].replace(/<[^>]*>/g, '').trim();
    if (hText.match(/\?|무엇|방법|어떻게|이유|how|what|why/i)) {
      const remainder   = html.substring(headingRegex.lastIndex);
      const answerMatch = remainder.match(/[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
      if (answerMatch) {
        const ansText = answerMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (ansText.length > 10)
          faqs.push({ "@type": "Question", "name": hText, "acceptedAnswer": { "@type": "Answer", "text": ansText } });
      }
    }
  }
  return faqs;
}

function buildSchemaScriptTag(meta, faqs, canonicalUrl) {
  const nodes = [{
    "@context": "https://schema.org", "@type": "Article",
    "headline": meta.title, "description": meta.descText,
    "url": canonicalUrl, "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl }
  }];
  if (faqs.length) nodes.push({ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faqs });
  // [WASM] XSS-safe 직렬화
  return `<script type="application/ld+json">${WasmDataProcessor.safeJsonStringify(nodes)}</script>`;
}

// [FIX-2]
function injectSeoTags(html, descText, canonicalUrl, schemaScript) {
  const safeDesc      = escapeHtmlAttr(descText);
  const safeCanonical = escapeHtmlAttr(canonicalUrl);
  const injection = `
    <meta name="description" content="${safeDesc}">
    <meta property="og:url" content="${safeCanonical}">
    <link rel="canonical" href="${safeCanonical}">
    ${schemaScript}`;
  if (!html.includes('</head>')) return html;
  return html.replace('</head>', injection + '\n</head>');
}

// [FIX-3] — worker.js 내 직접 호출은 WasmDataProcessor.batchReplaceLinks로 대체됨
// 호환성을 위해 래퍼 유지
function rewriteInternalLinksToSeoSlugs(html, origin) {
  return WasmDataProcessor.batchReplaceLinks(html, memFeedCache.pathToSlug, origin);
}

async function updateCacheBackground(originRequest, cacheKeyRequest, cache, canonicalUrl, isCustomSlug, origin, env, reserveKey) {
  try {
    const originResponse = await fetch(originRequest);
    if (!originResponse.ok) return;
    const ssrResponse = await performEdgeSideRendering(originResponse, canonicalUrl, isCustomSlug, origin, env);
    const cacheHeaders  = await WasmCdnOptimizer.buildOptimalHeaders(
      new URL(cacheKeyRequest.url).pathname,
      ssrResponse.headers.get('content-type') || '',
      null, ssrResponse.status
    );
    for (const [k, v] of Object.entries(cacheHeaders)) ssrResponse.headers.set(k, v);
    const htmlForReserve = await ssrResponse.clone().text();
    await cache.put(cacheKeyRequest, ssrResponse);
    await putToCacheReserve(env, reserveKey, htmlForReserve);
    await backupHtmlToGithub(env, reserveKey, htmlForReserve);
  } catch {}
}

// ---------------------------------------------------------------
// Cron: 미디어 업로드 큐
// ---------------------------------------------------------------
async function processMediaUploadQueue(env) {
  if (!env.MEDIA_KV) return;
  let processed = 0, cursor;
  try {
    do {
      const listResult = await env.MEDIA_KV.list({ prefix: 'media:', cursor, limit: 50 });
      for (const key of listResult.keys) {
        if (processed >= MAX_UPLOADS_PER_RUN) break;
        try {
          const raw    = await env.MEDIA_KV.get(key.name);
          const record = safeJsonParse(raw, null);
          if (!record || record.status !== 'pending') continue;
          // [FIX-17 guard] 과거 버그로 큐에 남은 CSS/JS 항목은 건너뛴다.
          if (/\.(css|js)(\?.*)?$/i.test(record.originalUrl || '')) continue;
          processed++;
          await uploadSingleMediaToGithub(env, key.name, record);
        } catch (e) { console.error('[processMediaUploadQueue] item error:', key.name, e); }
      }
      cursor = listResult.cursor;
      if (processed >= MAX_UPLOADS_PER_RUN) break;
    } while (cursor);
  } catch (e) { console.error('Media queue error:', e); }
}

async function uploadSingleMediaToGithub(env, kvKey, record) {
  try {
    const fetchRes = await fetch(record.originalUrl);
    if (!fetchRes.ok) {
      await env.MEDIA_KV.put(kvKey, JSON.stringify({ ...record, status: 'error', error: `fetch ${fetchRes.status}`, attemptedAt: Date.now() }));
      return;
    }
    const buffer   = await fetchRes.arrayBuffer();

    // [WASM] Node.js 환경이면 WebP 변환 시도
    let uploadBuffer = buffer;
    let repoPath     = await buildMediaRepoPath(record.originalUrl);
    const meta       = WasmImageProcessor.detectImageMeta(new Uint8Array(buffer));

    if (meta.format !== 'unknown' && meta.format !== 'webp' && meta.format !== 'gif') {
      // Edge에서는 convertToWebP 불가 → 원본 그대로
      // (Node.js 어댑터 경유 시 자동 처리됨)
    }

    await githubPutFile(env, repoPath, uploadBuffer, `media: ${repoPath}`);
    await purgeJsDelivr(env, repoPath);
    const jsdelivrUrl = buildJsDelivrUrl(env, repoPath);
    await env.MEDIA_KV.put(kvKey, JSON.stringify({ ...record, status: 'done', jsdelivrUrl, repoPath, doneAt: Date.now(), imgMeta: meta }));
  } catch (e) {
    await env.MEDIA_KV.put(kvKey, JSON.stringify({ ...record, status: 'error', error: String(e).substring(0, 200), attemptedAt: Date.now() }));
  }
}
