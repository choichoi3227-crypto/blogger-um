/**
 * server.js — Node.js 어댑터 (God Tier v7 + WASM)
 * ==================================================
 * Cloudflare Worker 로직을 Node.js HTTP 서버로 실행
 *
 * 특징
 *  - cluster 모듈로 CPU 코어 전체 활용 (Non-blocking I/O)
 *  - Worker 스레드 풀 (이미지 처리 CPU 집약 작업 분리)
 *  - node:stream Readable/Transform으로 응답 스트리밍
 *  - LRU 인메모리 캐시 (KV 폴백 — KV 없을 때도 동작)
 *  - http2 지원 (ALPN 협상)
 *  - Graceful shutdown (SIGTERM / SIGINT)
 *  - wasm-utils.js의 모든 WASM 기능 풀 활용
 *    - WasmImageProcessor: /api/image 엔드포인트에서 실시간 WebP 변환
 *    - WasmCompressor: Brotli/Gzip 응답 자동 압축
 *    - WasmCdnOptimizer: Cache-Control·ETag 자동 산출
 *    - WasmJsonParser: 피드 파싱 스트리밍
 *    - WasmDataProcessor: HTML 배치 처리
 */

'use strict';

import cluster       from 'node:cluster';
import os            from 'node:os';
import http          from 'node:http';
import http2         from 'node:http2';
import https         from 'node:https';
import fs            from 'node:fs';
import path          from 'node:path';
import { Readable }  from 'node:stream';
import { pipeline }  from 'node:stream/promises';
import { Worker as NodeWorker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  WasmHasher,
  WasmCompressor,
  WasmJsonParser,
  WasmImageProcessor,
  WasmCdnOptimizer,
  WasmDataProcessor,
  warmupWasm
} from './wasm-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 설정 ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '8080', 10);
const HOST        = process.env.HOST || '0.0.0.0';
const NUM_WORKERS = parseInt(process.env.WORKERS || String(os.availableParallelism()), 10);
const ORIGIN      = process.env.ORIGIN || `http://localhost:${PORT}`;
const USE_H2      = process.env.USE_HTTP2 === 'true';
const TLS_KEY     = process.env.TLS_KEY_PATH;
const TLS_CERT    = process.env.TLS_CERT_PATH;
const BLOG_ORIGIN = process.env.BLOG_ORIGIN || '';

// ─────────────────────────────────────────────────────────────────────────────
//  Worker Thread: 이미지 처리 (CPU 집약 → 메인 이벤트 루프 블로킹 방지)
// ─────────────────────────────────────────────────────────────────────────────
if (!isMainThread && workerData?.role === 'image') {
  const { buffer, opts } = workerData;
  (async () => {
    try {
      const result = await WasmImageProcessor.convertToWebP(Buffer.from(buffer), opts);
      parentPort.postMessage({ ok: true, buffer: result.buffer, contentType: result.contentType,
        originalSize: result.originalSize, outputSize: result.outputSize });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: e.message });
    }
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ImageWorkerPool — Worker Thread 풀 관리
// ─────────────────────────────────────────────────────────────────────────────
class ImageWorkerPool {
  #pool = [];
  #queue = [];
  #maxWorkers;

  constructor(maxWorkers = Math.max(2, Math.floor(os.availableParallelism() / 2))) {
    this.#maxWorkers = maxWorkers;
  }

  async convertToWebP(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
      const task = { buffer, opts, resolve, reject };
      const idle = this.#pool.find(w => !w.busy);
      if (idle) this.#runTask(idle, task);
      else if (this.#pool.length < this.#maxWorkers) this.#spawnWorker(task);
      else this.#queue.push(task);
    });
  }

  #spawnWorker(task) {
    const workerEntry = { worker: null, busy: true };
    const w = new NodeWorker(fileURLToPath(import.meta.url), {
      workerData: { role: 'image', buffer: task.buffer, opts: task.opts }
    });
    workerEntry.worker = w;
    this.#pool.push(workerEntry);
    w.once('message', msg => {
      task.resolve(msg.ok ? msg : (() => { throw new Error(msg.error); })());
      workerEntry.busy = false;
      this.#dequeue(workerEntry);
    });
    w.once('error', err => { task.reject(err); workerEntry.busy = false; this.#dequeue(workerEntry); });
  }

  #runTask(workerEntry, task) {
    workerEntry.busy = true;
    workerEntry.worker.postMessage({ buffer: task.buffer, opts: task.opts });
    workerEntry.worker.once('message', msg => {
      (msg.ok ? task.resolve : task.reject)(msg.ok ? msg : new Error(msg.error));
      workerEntry.busy = false;
      this.#dequeue(workerEntry);
    });
  }

  #dequeue(workerEntry) {
    const next = this.#queue.shift();
    if (next) this.#runTask(workerEntry, next);
  }

  async destroy() {
    await Promise.all(this.#pool.map(e => e.worker.terminate()));
    this.#pool = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LRU 인메모리 캐시 (KV 대체)
// ─────────────────────────────────────────────────────────────────────────────
class LruCache {
  #map = new Map();
  #maxSize;

  constructor(maxSize = 500) { this.#maxSize = maxSize; }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key);
    if (v.expiresAt && v.expiresAt < Date.now()) { this.#map.delete(key); return undefined; }
    // LRU: 접근 시 맨 뒤로 이동
    this.#map.delete(key);
    this.#map.set(key, v);
    return v.value;
  }

  set(key, value, ttlMs = 0) {
    this.#map.delete(key);
    if (this.#map.size >= this.#maxSize) {
      this.#map.delete(this.#map.keys().next().value);
    }
    this.#map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  }

  delete(key) { this.#map.delete(key); }
  get size()   { return this.#map.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Node.js 환경 KV 심 (worker.js 호환)
// ─────────────────────────────────────────────────────────────────────────────
function buildNodeKv(lru, ttlMs = 0) {
  return {
    async get(key)         { return lru.get(key) ?? null; },
    async put(key, value)  { lru.set(key, value, ttlMs); },
    async delete(key)      { lru.delete(key); },
    async list({ prefix = '', cursor, limit = 100 } = {}) {
      // Node.js 심: 실 KV 없이 키 열거 불가 → 빈 결과
      return { keys: [], cursor: null };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Node.js → Worker 호환 env 빌드
// ─────────────────────────────────────────────────────────────────────────────
function buildNodeEnv(nodeKvInstances) {
  return {
    GITHUB_TOKEN : process.env.GITHUB_TOKEN  || '',
    GITHUB_OWNER : process.env.GITHUB_OWNER  || '',
    GITHUB_REPO  : process.env.GITHUB_REPO   || '',
    GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
    SLUG_KV       : nodeKvInstances.slugKv,
    MEDIA_KV      : nodeKvInstances.mediaKv,
    CACHE_RESERVE_KV: nodeKvInstances.cacheKv
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Node.js → Worker 호환 Request / Response 변환
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IncomingMessage → Web API Request 변환
 * Non-blocking: 바디는 스트림 통해 읽음
 */
async function nodeReqToWebRequest(req, body) {
  const protocol = req.socket?.encrypted ? 'https' : 'http';
  const host     = req.headers.host || `localhost:${PORT}`;
  let url;
  try { url = new URL(req.url, `${protocol}://${host}`); }
  catch { url = new URL('/', `${protocol}://${host}`); }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(vi => headers.append(k, vi));
    else if (v)           headers.set(k, v);
  }

  return new Request(url.toString(), {
    method : req.method || 'GET',
    headers,
    body   : ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    // Node.js 확장: cf 유사 정보
    cf     : { continent: 'NA', colo: 'NODE' }
  });
}

/**
 * Web API Response → ServerResponse 스트리밍 출력
 * Node.js 스트림 파이프로 Non-blocking
 */
async function webResponseToNodeRes(webRes, res) {
  res.statusCode = webRes.status || 200;

  for (const [k, v] of webRes.headers.entries()) {
    try { res.setHeader(k, v); } catch {}
  }

  if (!webRes.body) { res.end(); return; }

  // ReadableStream → Node Readable 변환
  const reader = webRes.body.getReader();
  const nodeReadable = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) this.push(null);
        else      this.push(Buffer.from(value));
      } catch (e) { this.destroy(e); }
    }
  });

  try {
    await pipeline(nodeReadable, res);
  } catch (e) {
    if (e.code !== 'ERR_STREAM_DESTROYED' && e.code !== 'EPIPE') {
      console.error('[webResponseToNodeRes] pipeline error:', e.code);
    }
    try { res.end(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  요청 바디 수집 (Non-blocking, 크기 제한)
// ─────────────────────────────────────────────────────────────────────────────
function collectBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total    = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  /api/image — 실시간 이미지 WebP 변환 엔드포인트 (Node.js 전용)
// ─────────────────────────────────────────────────────────────────────────────
async function handleImageApiRequest(req, res, pool) {
  try {
    const url      = new URL(req.url, `http://localhost`);
    const srcUrl   = url.searchParams.get('src');
    const width    = parseInt(url.searchParams.get('w') || '0', 10) || undefined;
    const height   = parseInt(url.searchParams.get('h') || '0', 10) || undefined;
    const quality  = parseInt(url.searchParams.get('q') || '80', 10);
    const format   = url.searchParams.get('f') || 'webp';

    if (!srcUrl) { res.writeHead(400); res.end('Missing ?src='); return; }

    // 원본 이미지 fetch (Non-blocking)
    const fetchRes = await fetch(srcUrl);
    if (!fetchRes.ok) { res.writeHead(502); res.end(`Origin ${fetchRes.status}`); return; }
    const inputBuffer = Buffer.from(await fetchRes.arrayBuffer());

    // [WASM] 이미지 메타 감지
    const meta = WasmImageProcessor.detectImageMeta(new Uint8Array(inputBuffer));

    let outputBuffer, contentType, originalSize, outputSize;
    if (format === 'webp' && meta.format !== 'webp') {
      // Worker Thread 풀로 CPU 집약 작업 분리
      const result = await pool.convertToWebP(inputBuffer, { width, height, quality });
      outputBuffer = result.buffer;
      contentType  = result.contentType;
      originalSize = result.originalSize;
      outputSize   = result.outputSize;
    } else {
      outputBuffer = inputBuffer;
      contentType  = meta.contentType;
      originalSize = outputSize = inputBuffer.length;
    }

    // [WASM] ETag 생성
    const etag = await WasmHasher.etag(outputBuffer);

    const cacheHeaders = await WasmCdnOptimizer.buildOptimalHeaders('/image.webp', contentType, null);

    res.writeHead(200, {
      'Content-Type'    : contentType,
      'Content-Length'  : outputBuffer.length,
      'ETag'            : etag,
      'X-Original-Size' : originalSize,
      'X-Output-Size'   : outputSize,
      'X-Image-Format'  : meta.format,
      ...cacheHeaders
    });
    res.end(outputBuffer);
  } catch (e) {
    console.error('[handleImageApiRequest]', e);
    res.writeHead(500); res.end('Image processing error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  /api/feed — 피드 JSON 스트리밍 파싱 + 슬러그 맵 반환
// ─────────────────────────────────────────────────────────────────────────────
async function handleFeedApiRequest(req, res) {
  try {
    const url     = new URL(req.url, `http://localhost`);
    const origin  = url.searchParams.get('origin') || BLOG_ORIGIN;
    if (!origin) { res.writeHead(400); res.end('Missing ?origin='); return; }

    const feedUrl = `${origin}/feeds/posts/default?alt=json&max-results=500`;
    const feedRes = await fetch(feedUrl);
    if (!feedRes.ok) { res.writeHead(502); res.end(`Feed fetch ${feedRes.status}`); return; }

    // [WASM] 스트리밍 JSON 파싱
    const feedJson = await WasmJsonParser.parseStream(feedRes.body);
    const rawEntries = feedJson?.feed?.entry;

    // [WASM] 배치 정규화
    const normalized = WasmDataProcessor.normalizeFeedEntries(rawEntries);
    const payload    = WasmDataProcessor.safeJsonStringify({ count: normalized.length, entries: normalized });

    // [WASM] Brotli 압축
    const { body, encoding } = await WasmCompressor.compressResponse(payload, req.headers['accept-encoding'] || '');

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=1800',
      ...(encoding ? { 'Content-Encoding': encoding } : {})
    };
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    console.error('[handleFeedApiRequest]', e);
    res.writeHead(500); res.end('Feed error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  메인 요청 핸들러 (Non-blocking I/O)
// ─────────────────────────────────────────────────────────────────────────────
function buildRequestHandler(workerModule, env, pool) {
  return async function requestHandler(req, res) {
    const start = Date.now();

    try {
      const url = new URL(req.url || '/', `http://localhost`);

      // ── 내부 API 라우팅 ──────────────────────────────────────────────────
      if (url.pathname === '/api/image') {
        await handleImageApiRequest(req, res, pool);
        return;
      }
      if (url.pathname === '/api/feed') {
        await handleFeedApiRequest(req, res);
        return;
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', pid: process.pid,
          uptime: Math.floor(process.uptime()),
          mem: process.memoryUsage()
        }));
        return;
      }

      // ── Worker 로직으로 프록시 ────────────────────────────────────────────
      let bodyBuffer;
      try {
        if (!['GET', 'HEAD'].includes(req.method)) bodyBuffer = await collectBody(req);
      } catch (e) {
        res.writeHead(413); res.end('Payload Too Large'); return;
      }

      const webReq = await nodeReqToWebRequest(req, bodyBuffer);

      // Node.js 호환 ctx (waitUntil → 백그라운드 Promise 추적)
      const pendingTasks = [];
      const ctx = {
        waitUntil: (p) => pendingTasks.push(Promise.resolve(p).catch(e =>
          console.error('[waitUntil task error]', e)))
      };

      const webRes = await workerModule.default.fetch(webReq, env, ctx);

      // [WASM] ETag 조건부 요청 처리 (304 응답)
      const etag = webRes.headers.get('ETag');
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': webRes.headers.get('Cache-Control') || '' });
        res.end();
      } else {
        // [WASM] 응답 압축 (Worker가 이미 압축했다면 스킵)
        if (!webRes.headers.get('Content-Encoding')) {
          const ct = webRes.headers.get('content-type') || '';
          if (ct.includes('text/html') || ct.includes('application/json')) {
            const html = await webRes.text();
            const { body, encoding } = await WasmCompressor.compressResponse(html, req.headers['accept-encoding'] || '');
            const h = Object.fromEntries(webRes.headers.entries());
            if (encoding) { h['content-encoding'] = encoding; delete h['content-length']; }
            res.writeHead(webRes.status, h);
            res.end(body);
          } else {
            await webResponseToNodeRes(webRes, res);
          }
        } else {
          await webResponseToNodeRes(webRes, res);
        }
      }

      // 백그라운드 태스크 비동기 실행 (Non-blocking)
      if (pendingTasks.length) Promise.allSettled(pendingTasks);

    } catch (e) {
      console.error('[requestHandler] unhandled error:', e);
      if (!res.headersSent) { res.writeHead(502); res.end('Gateway Error'); }
    }

    const elapsed = Date.now() - start;
    if (elapsed > 2000) console.warn(`[SLOW] ${req.method} ${req.url} — ${elapsed}ms`);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  서버 생성 (HTTP/1.1 or HTTP/2)
// ─────────────────────────────────────────────────────────────────────────────
function createServer(handler) {
  if (USE_H2 && TLS_KEY && TLS_CERT) {
    const tlsOptions = {
      key : fs.readFileSync(TLS_KEY),
      cert: fs.readFileSync(TLS_CERT),
      allowHTTP1: true  // HTTP/1.1 폴백 허용 (ALPN)
    };
    return http2.createSecureServer(tlsOptions, handler);
  }
  if (TLS_KEY && TLS_CERT) {
    return https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, handler);
  }
  return http.createServer(handler);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
function setupGracefulShutdown(server, pool, onDone) {
  const shutdown = async (signal) => {
    console.log(`[${process.pid}] ${signal} received — graceful shutdown...`);
    server.close(async () => {
      await pool?.destroy().catch(() => {});
      console.log(`[${process.pid}] Server closed.`);
      onDone?.();
      process.exit(0);
    });
    // 30초 강제 종료
    setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 30_000);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cluster Primary (마스터)
// ─────────────────────────────────────────────────────────────────────────────
async function runPrimary() {
  console.log(`[primary] PID=${process.pid} — spawning ${NUM_WORKERS} workers`);
  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[primary] Worker ${worker.process.pid} exited (${signal || code}) — restarting`);
    cluster.fork();
  });

  process.once('SIGTERM', () => {
    for (const w of Object.values(cluster.workers)) w.kill('SIGTERM');
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cluster Worker (서버 프로세스)
// ─────────────────────────────────────────────────────────────────────────────
async function runWorkerProcess() {
  console.log(`[worker] PID=${process.pid} — initializing WASM...`);

  // WASM 모듈 워밍업
  await warmupWasm();
  console.log(`[worker] PID=${process.pid} — WASM ready`);

  // KV 인스턴스 (인메모리 LRU)
  const slugLru  = new LruCache(2000);
  const mediaLru = new LruCache(1000);
  const cacheLru = new LruCache(200);

  const env = buildNodeEnv({
    slugKv : buildNodeKv(slugLru, 1000 * 60 * 60 * 24),   // 24h TTL
    mediaKv: buildNodeKv(mediaLru, 1000 * 60 * 60 * 24 * 7), // 7d TTL
    cacheKv: buildNodeKv(cacheLru, 1000 * 60 * 60 * 2)    // 2h TTL
  });

  // 이미지 처리 Worker Thread 풀
  const pool = new ImageWorkerPool(Math.max(1, Math.floor(NUM_WORKERS / 2)));

  // worker.js 동적 임포트
  const workerModule = await import('./worker.js');

  const handler = buildRequestHandler(workerModule, env, pool);
  const server  = createServer(handler);

  server.listen(PORT, HOST, () => {
    const proto = USE_H2 && TLS_KEY ? 'https (HTTP/2)' : TLS_KEY ? 'https' : 'http';
    console.log(`[worker] PID=${process.pid} — listening on ${proto}://${HOST}:${PORT}`);
  });

  // Keep-Alive 최적화
  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;

  setupGracefulShutdown(server, pool);

  // 메모리 사용량 주기적 리포트 (15분)
  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`[worker] PID=${process.pid} mem: rss=${Math.round(mem.rss / 1024 / 1024)}MB heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
  }, 15 * 60 * 1000).unref();
}

// ─────────────────────────────────────────────────────────────────────────────
//  단일 프로세스 모드 (NO_CLUSTER=true 환경변수)
// ─────────────────────────────────────────────────────────────────────────────
async function runSingleProcess() {
  console.log(`[single] PID=${process.pid}`);
  await runWorkerProcess();
}

// ─────────────────────────────────────────────────────────────────────────────
//  진입점
// ─────────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  // Worker Thread: 이미지 처리 (상단에서 처리됨)
} else if (process.env.NO_CLUSTER === 'true') {
  runSingleProcess().catch(e => { console.error(e); process.exit(1); });
} else if (cluster.isPrimary) {
  runPrimary().catch(e => { console.error(e); process.exit(1); });
} else {
  runWorkerProcess().catch(e => { console.error(e); process.exit(1); });
}

export { buildRequestHandler, buildNodeEnv, LruCache, ImageWorkerPool, WasmHasher, WasmCompressor };
