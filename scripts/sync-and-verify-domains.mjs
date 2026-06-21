#!/usr/bin/env node
/**
 * scripts/sync-and-verify-domains.mjs
 * ====================================================================
 * 목적 (요청 3, 4, 5 대응)
 *  3) 라우트로 등록된 "모든" 도메인의 A 레코드가 반드시 Blogspot 공식 IP를
 *     가리키도록 자동 강제한다 (사용자가 도메인을 추가할 때마다 수동으로
 *     DNS를 만질 필요가 없도록 함).
 *  4) 도메인별로 실제 HTTP 응답(status, content-type, 압축/인코딩 깨짐
 *     여부, 무한 리디렉션 여부)을 확인하고 리포트한다.
 *  5) 특정 zone에 하드코딩하지 않는다 — Cloudflare 계정 전체를 대상으로
 *     이 워커(WORKER_SCRIPT_NAME)에 바인딩된 모든 도메인을 자동으로
 *     찾아낸다 (Workers Custom Domains API + 레거시 Zone Routes API 모두
 *     스캔하여 합집합을 구함).
 *
 * 동작 방식
 *  1. Cloudflare 계정(Account) 전체에서 워커에 연결된 커스텀 도메인 목록을
 *     가져온다: GET /accounts/:account_id/workers/domains
 *     (이 엔드포인트는 zone에 종속되지 않고 계정 전체를 스캔한다.)
 *  2. 보조로, 계정에 속한 모든 zone을 순회하며 레거시 Worker Route
 *     (`GET /zones/:zone_id/workers/routes`)에 이 워커 스크립트가 걸린
 *     호스트도 함께 수집한다 (신·구 방식 혼재 환경 대응).
 *  3. 수집된 모든 (zone_id, hostname) 쌍에 대해:
 *      - 기존 DNS 레코드(A/AAAA/CNAME)를 조회
 *      - CNAME 등 충돌 레코드가 있으면 제거
 *      - Blogspot 공식 IP 4개로 A 레코드 4개를 멱등적으로 생성/교정
 *      - proxied(주황 구름) = true 로 강제 (Worker가 가로채야 하므로)
 *  4. 각 도메인에 대해 실제 fetch를 수행해 상태코드/리디렉션 체인 길이/
 *     인코딩 정상 여부를 점검하고 결과를 표로 출력한다.
 *
 * 필요 환경변수
 *  CF_API_TOKEN      Cloudflare API 토큰. 최소 권한:
 *                       Account.Workers Scripts:Read, Account.Workers Routes:Read,
 *                       Zone.DNS:Edit, Zone.Workers Routes:Read, Zone.Zone:Read
 *  CF_ACCOUNT_ID     Cloudflare 계정 ID
 *  WORKER_SCRIPT_NAME 이 워커의 스크립트 이름 (기본값 'blogger-um')
 *  DRY_RUN           'true'면 실제 변경 없이 무엇을 할지만 출력
 *
 * 실행
 *  node scripts/sync-and-verify-domains.mjs
 */

const CF_API_BASE      = 'https://api.cloudflare.com/client/v4';
const CF_API_TOKEN     = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID    = process.env.CF_ACCOUNT_ID;
const WORKER_SCRIPT    = process.env.WORKER_SCRIPT_NAME || 'blogger-um';
const DRY_RUN          = process.env.DRY_RUN === 'true';

// Blogspot(Google Sites/Blogger) 커스텀 도메인 공식 A 레코드 IP 4종
const BLOGSPOT_IPS = [
  '216.239.32.21',
  '216.239.34.21',
  '216.239.36.21',
  '216.239.38.21'
];

if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
  console.error('[fatal] CF_API_TOKEN, CF_ACCOUNT_ID 환경변수가 필요합니다.');
  process.exit(1);
}

const cfHeaders = {
  'Authorization': `Bearer ${CF_API_TOKEN}`,
  'Content-Type' : 'application/json'
};

async function cf(method, path, body) {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: cfHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    const errMsg = json?.errors?.map(e => `${e.code}: ${e.message}`).join('; ') || res.statusText;
    throw new Error(`CF API ${method} ${path} 실패: ${errMsg}`);
  }
  return json;
}

async function cfPaginated(path, params = {}) {
  const results = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ ...params, page: String(page), per_page: '50' });
    const json = await cf('GET', `${path}?${qs.toString()}`);
    results.push(...(json.result || []));
    const info = json.result_info;
    if (!info || page >= info.total_pages) break;
    page++;
  }
  return results;
}

// ---------------------------------------------------------------
// 1) 계정 전체에서 이 워커에 바인딩된 커스텀 도메인 수집 (zone 비종속)
// ---------------------------------------------------------------
async function collectAccountCustomDomains() {
  let domains = [];
  try {
    const json = await cf('GET', `/accounts/${CF_ACCOUNT_ID}/workers/domains`);
    domains = (json.result || [])
      .filter(d => d.service === WORKER_SCRIPT) // 이 워커에 연결된 것만
      .map(d => ({ hostname: d.hostname, zoneId: d.zone_id, zoneName: d.zone_name, source: 'custom_domain' }));
  } catch (e) {
    console.warn('[warn] Workers Custom Domains API 조회 실패(권한 또는 미사용일 수 있음):', e.message);
  }
  return domains;
}

// ---------------------------------------------------------------
// 2) 계정의 모든 zone을 순회하며 레거시 Worker Route에 걸린 호스트 수집
//    (특정 zone에 하드코딩하지 않고 계정 내 전체 zone을 자동 스캔)
// ---------------------------------------------------------------
async function collectAllZones() {
  return cfPaginated('/zones', { 'account.id': CF_ACCOUNT_ID });
}

function extractHostnameFromRoutePattern(pattern) {
  // 예: "example.com/*" -> "example.com", "*.example.com/*" -> "example.com" (와일드카드 루트만 채택)
  let host = pattern.split('/')[0];
  host = host.replace(/^\*\./, '').replace(/^\*/, '');
  return host || null;
}

async function collectZoneRouteDomains(zones) {
  const found = [];
  for (const zone of zones) {
    let routes = [];
    try {
      const json = await cf('GET', `/zones/${zone.id}/workers/routes`);
      routes = json.result || [];
    } catch (e) {
      console.warn(`[warn] ${zone.name} 라우트 조회 실패:`, e.message);
      continue;
    }
    for (const route of routes) {
      if (route.script !== WORKER_SCRIPT) continue;
      const hostname = extractHostnameFromRoutePattern(route.pattern || '');
      if (!hostname) continue;
      found.push({ hostname, zoneId: zone.id, zoneName: zone.name, source: 'zone_route' });
    }
  }
  return found;
}

function dedupeDomains(list) {
  const map = new Map();
  for (const d of list) {
    const key = d.hostname.toLowerCase();
    if (!map.has(key)) map.set(key, d);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------
// 3) DNS 동기화 — A 레코드를 Blogspot 공식 IP로 강제
// ---------------------------------------------------------------
async function ensureBlogspotARecords(zoneId, hostname) {
  const actions = [];
  const existing = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const records = existing.result || [];

  // 3-1) A/AAAA가 아닌 충돌 레코드(CNAME 등)는 제거해야 A 레코드 추가 가능
  for (const rec of records) {
    if (rec.type !== 'A') {
      actions.push({ type: 'delete-conflict', recId: rec.id, recType: rec.type, recContent: rec.content });
      if (!DRY_RUN) await cf('DELETE', `/zones/${zoneId}/dns_records/${rec.id}`);
    }
  }

  const currentA = records.filter(r => r.type === 'A');
  const currentIps = new Set(currentA.map(r => r.content));

  // 3-2) 공식 IP에 없는 기존 A 레코드는 제거 (다른 IP로 잘못 설정된 경우 강제 교정)
  for (const rec of currentA) {
    if (!BLOGSPOT_IPS.includes(rec.content)) {
      actions.push({ type: 'delete-wrong-ip', recId: rec.id, recContent: rec.content });
      if (!DRY_RUN) await cf('DELETE', `/zones/${zoneId}/dns_records/${rec.id}`);
    }
  }

  // 3-3) 누락된 공식 IP A 레코드 생성 + proxied 강제
  for (const ip of BLOGSPOT_IPS) {
    const already = currentA.find(r => r.content === ip);
    if (already) {
      if (!already.proxied) {
        actions.push({ type: 'enable-proxy', recId: already.id, ip });
        if (!DRY_RUN) await cf('PUT', `/zones/${zoneId}/dns_records/${already.id}`, {
          type: 'A', name: hostname, content: ip, proxied: true, ttl: 1
        });
      }
      continue;
    }
    actions.push({ type: 'create', ip });
    if (!DRY_RUN) await cf('POST', `/zones/${zoneId}/dns_records`, {
      type: 'A', name: hostname, content: ip, proxied: true, ttl: 1
    });
  }

  return actions;
}

// ---------------------------------------------------------------
// 4) 응답 검증 — 실제로 정상 동작하는지 확인
// ---------------------------------------------------------------
function looksGarbled(text) {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  const replacementChars = (sample.match(/\uFFFD/g) || []).length;
  // 제어문자(개행/탭 제외) 비율이 높으면 압축 바이트가 그대로 노출된 것으로 간주
  const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
  return replacementChars > 5 || controlChars > 20;
}

async function verifyDomain(hostname) {
  const result = { hostname, ok: false, status: null, redirectHops: 0, garbled: false, error: null };
  try {
    let currentUrl = `https://${hostname}/`;
    const seen = new Set();
    let finalRes = null;
    for (let hop = 0; hop < 6; hop++) {
      if (seen.has(currentUrl)) { result.error = '리디렉션 루프 감지'; break; }
      seen.add(currentUrl);
      const res = await fetch(currentUrl, { redirect: 'manual' });
      result.status = res.status;
      if ([301, 302, 307, 308].includes(res.status)) {
        result.redirectHops++;
        const loc = res.headers.get('location');
        if (!loc) { result.error = 'Location 헤더 없는 리디렉션'; break; }
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }
      finalRes = res;
      break;
    }
    if (result.redirectHops >= 5) result.error = result.error || '리디렉션 과다(5회 이상)';
    if (finalRes) {
      const text = await finalRes.text().catch(() => '');
      result.garbled = looksGarbled(text);
      result.contentType = finalRes.headers.get('content-type') || '';
      result.ok = finalRes.status === 200 && !result.garbled;
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// ---------------------------------------------------------------
// 메인
// ---------------------------------------------------------------
async function main() {
  console.log(`[start] 워커 '${WORKER_SCRIPT}'에 연결된 모든 도메인 스캔 중... (DRY_RUN=${DRY_RUN})`);

  const [accountDomains, zones] = await Promise.all([
    collectAccountCustomDomains(),
    collectAllZones()
  ]);
  const zoneRouteDomains = await collectZoneRouteDomains(zones);

  const allDomains = dedupeDomains([...accountDomains, ...zoneRouteDomains]);
  console.log(`[info] 발견된 도메인 수: ${allDomains.length}`);

  if (allDomains.length === 0) {
    console.log('[info] 워커에 연결된 도메인이 없습니다. Custom Domains 또는 Zone Routes 설정을 확인하세요.');
    return;
  }

  const dnsReport = [];
  for (const d of allDomains) {
    if (!d.zoneId) {
      dnsReport.push({ hostname: d.hostname, error: 'zone_id를 찾을 수 없어 DNS 동기화 건너뜀' });
      continue;
    }
    try {
      const actions = await ensureBlogspotARecords(d.zoneId, d.hostname);
      dnsReport.push({ hostname: d.hostname, zone: d.zoneName, actions });
    } catch (e) {
      dnsReport.push({ hostname: d.hostname, error: e.message });
    }
  }

  console.log('\n=== DNS 동기화 결과 ===');
  for (const r of dnsReport) {
    if (r.error) { console.log(`✗ ${r.hostname} — ${r.error}`); continue; }
    if (!r.actions.length) { console.log(`✓ ${r.hostname} — 이미 정상 (변경 없음)`); continue; }
    console.log(`✓ ${r.hostname} (${r.zone}) — ${r.actions.length}건 적용:`);
    for (const a of r.actions) console.log(`    - ${JSON.stringify(a)}`);
  }

  console.log('\n[info] 전파 대기 후 응답 검증 시작 (DNS 변경 직후라면 수 분 소요될 수 있음)...');
  const verifyResults = await Promise.all(allDomains.map(d => verifyDomain(d.hostname)));

  console.log('\n=== 응답 검증 결과 ===');
  let failCount = 0;
  for (const r of verifyResults) {
    const mark = r.ok ? '✓' : '✗';
    if (!r.ok) failCount++;
    console.log(
      `${mark} ${r.hostname} — status=${r.status ?? '-'} redirects=${r.redirectHops} ` +
      `garbled=${r.garbled} ct="${r.contentType || ''}"${r.error ? ` error="${r.error}"` : ''}`
    );
  }

  console.log(`\n[summary] 총 ${allDomains.length}개 도메인 / 실패 ${failCount}개`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
