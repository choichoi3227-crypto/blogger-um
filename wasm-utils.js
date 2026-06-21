/**
 * wasm-utils.js — WASM 고성능 연산 레이어
 * ===========================================
 * 환경 감지 후 WASM / Pure-JS 폴백 자동 선택
 *
 * 제공 기능
 *  - WasmImageProcessor  : 이미지 리사이즈·WebP 변환·메타데이터 추출
 *  - WasmCompressor      : Brotli / Gzip 압축 (응답 압축 + Cache payload 최소화)
 *  - WasmJsonParser      : 대형 JSON 스트리밍 파싱 (피드 파싱 가속)
 *  - WasmHasher          : SHA-256 / xxHash (캐시 키 생성)
 *  - WasmCdnOptimizer    : CDN 캐시 전략 결정 (TTL 계산, ETag 생성)
 *
 * WASM 소스 매핑 (런타임에 동적 로드)
 *  - @squoosh/lib        : 이미지 (Node.js only)
 *  - fflate              : 압축 (Edge + Node.js 공용, 순수 JS + WASM fallback)
 *  - simdjson-wasm       : JSON 파싱 (선택적)
 */

// ─── 환경 감지 ───────────────────────────────────────────────────────────────
const IS_EDGE   = typeof caches !== 'undefined' && typeof WorkerGlobalScope !== 'undefined';
const IS_NODE   = typeof process !== 'undefined' && process.versions && process.versions.node;

// ─── 공유 유틸 ───────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getEnvVar(key) {
  if (IS_NODE && process.env[key]) return process.env[key];
  // Edge: env는 fetch() 핸들러에서 외부 주입
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmHasher
//  환경: Edge (WebCrypto), Node.js (crypto 모듈)
// ─────────────────────────────────────────────────────────────────────────────
export class WasmHasher {
  /** SHA-256 hex 문자열 */
  static async sha256(text) {
    const encoded = new TextEncoder().encode(text);
    if (IS_NODE) {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(encoded).digest('hex');
    }
    // Edge: WebCrypto
    const buf = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 빠른 비암호화 해시 (FNV-1a 32bit) — WASM 없이도 고속
   * 캐시 샤딩·ETag 보조용
   */
  static fnv1a32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /** ETag 생성: SHA-256 앞 16자 */
  static async etag(content) {
    const h = await WasmHasher.sha256(
      typeof content === 'string' ? content : new TextDecoder().decode(content)
    );
    return `"${h.substring(0, 16)}"`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmCompressor
//  fflate (WASM-accelerated) 사용 / 없으면 CompressionStream 폴백
// ─────────────────────────────────────────────────────────────────────────────
export class WasmCompressor {
  static #fflate = null;
  static #initPromise = null;

  static async #init() {
    if (WasmCompressor.#fflate) return;
    if (WasmCompressor.#initPromise) { await WasmCompressor.#initPromise; return; }
    WasmCompressor.#initPromise = (async () => {
      try {
        // fflate는 Edge + Node.js 양쪽에서 동작하는 순수 JS + WASM 혼합 라이브러리
        WasmCompressor.#fflate = await import('fflate');
      } catch {
        WasmCompressor.#fflate = null; // 폴백 모드
      }
    })();
    await WasmCompressor.#initPromise;
  }

  /**
   * Gzip 압축
   * @param {Uint8Array|string} input
   * @param {number} level 0-9 (기본 6)
   * @returns {Promise<Uint8Array>}
   */
  static async gzip(input, level = 6) {
    await WasmCompressor.#init();
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;

    if (WasmCompressor.#fflate) {
      const { gzip } = WasmCompressor.#fflate;
      return new Promise((resolve, reject) =>
        gzip(data, { level: clamp(level, 0, 9) }, (err, out) => err ? reject(err) : resolve(out))
      );
    }
    // 폴백: CompressionStream (Edge 표준 API)
    return WasmCompressor.#compressViaStream(data, 'gzip');
  }

  /**
   * Brotli 압축 (fflate 지원 시; Node.js zlib 폴백)
   * [FIX-14] fflate 0.8.x는 브라우저/엣지 빌드에 brotliCompress를 포함하지 않으므로
   * 항상 폴백 분기를 탄다. 실제로 br로 압축됐는지 여부를 함께 반환해
   * 호출부가 Content-Encoding 헤더를 거짓으로 'br'로 설정하지 않게 한다.
   */
  static async brotli(input, quality = 6) {
    await WasmCompressor.#init();
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;

    if (WasmCompressor.#fflate && WasmCompressor.#fflate.brotliCompress) {
      const { brotliCompress } = WasmCompressor.#fflate;
      const out = await new Promise((resolve, reject) =>
        brotliCompress(data, { quality: clamp(quality, 0, 11) }, (err, out) => err ? reject(err) : resolve(out))
      );
      return { data: out, usedBrotli: true };
    }

    if (IS_NODE) {
      const { brotliCompress: zlibBr } = await import('node:zlib');
      const { promisify } = await import('node:util');
      const out = await promisify(zlibBr)(data, { params: { [1]: clamp(quality, 0, 11) } });
      return { data: out, usedBrotli: true };
    }

    // Edge 폴백: gzip으로 대체 (brotli 미지원 환경) — usedBrotli=false 로 표시
    const out = await WasmCompressor.#compressViaStream(data, 'gzip');
    return { data: out, usedBrotli: false };
  }

  /**
   * 압축 해제
   */
  static async decompress(data, encoding = 'gzip') {
    await WasmCompressor.#init();
    if (WasmCompressor.#fflate) {
      const fn = encoding === 'br' || encoding === 'brotli'
        ? WasmCompressor.#fflate.brotliDecompress
        : WasmCompressor.#fflate.gunzip;
      if (fn) {
        return new Promise((resolve, reject) =>
          fn(data, (err, out) => err ? reject(err) : resolve(out))
        );
      }
    }
    return WasmCompressor.#decompressViaStream(data, encoding === 'br' ? 'gzip' : encoding);
  }

  static async #compressViaStream(data, format) {
    const cs = new CompressionStream(format);
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  static async #decompressViaStream(data, format) {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  /**
   * HTML 응답 자동 압축 + 헤더 설정
   * Accept-Encoding 협상 포함
   */
  static async compressResponse(html, acceptEncoding = '') {
    const encoded = new TextEncoder().encode(html);
    let body, encoding;

    try {
      if (acceptEncoding.includes('br')) {
        const result = await WasmCompressor.brotli(encoded, 5);
        body     = result.data;
        encoding = result.usedBrotli ? 'br' : 'gzip'; // [FIX-14] 실제 압축 방식과 헤더 일치
      } else if (acceptEncoding.includes('gzip')) {
        body = await WasmCompressor.gzip(encoded, 6);
        encoding = 'gzip';
      } else {
        return { body: encoded, encoding: null };
      }
      return { body, encoding };
    } catch {
      return { body: encoded, encoding: null };
    }
  }

  /**
   * KV 저장 전 HTML 압축 → Base64 (캐시 페이로드 최소화)
   */
  static async packForKv(html) {
    try {
      const compressed = await WasmCompressor.gzip(html, 9);
      return { v: 2, enc: 'gz', data: WasmCompressor.#arrayToBase64(compressed) };
    } catch {
      return { v: 2, enc: 'raw', data: html };
    }
  }

  static async unpackFromKv(packed) {
    if (!packed || typeof packed === 'string') return packed;
    if (packed.enc === 'gz') {
      const bytes = WasmCompressor.#base64ToArray(packed.data);
      const out = await WasmCompressor.decompress(bytes, 'gzip');
      return new TextDecoder().decode(out);
    }
    return packed.data;
  }

  static #arrayToBase64(arr) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < arr.length; i += CHUNK)
      bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
    return btoa(bin);
  }

  static #base64ToArray(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmJsonParser
//  대형 Blogger 피드(수백 KB) JSON 파싱 가속
//  simdjson-wasm 사용 / 폴백: JSON.parse (V8 내장)
// ─────────────────────────────────────────────────────────────────────────────
export class WasmJsonParser {
  static #simd = null;
  static #initAttempted = false;

  static async #tryInit() {
    if (WasmJsonParser.#initAttempted) return;
    WasmJsonParser.#initAttempted = true;
    try {
      const mod = await import('simdjson-wasm');
      await mod.default();               // WASM 초기화
      WasmJsonParser.#simd = mod;
    } catch {
      WasmJsonParser.#simd = null;
    }
  }

  /**
   * JSON 파싱 — WASM 가속 or V8 폴백
   * @param {string|Uint8Array} input
   */
  static async parse(input) {
    await WasmJsonParser.#tryInit();
    const text = typeof input === 'string' ? input : new TextDecoder().decode(input);

    if (WasmJsonParser.#simd) {
      try {
        return WasmJsonParser.#simd.parse(text);
      } catch {
        // simdjson 실패 시 V8 폴백
      }
    }
    return JSON.parse(text);
  }

  /**
   * 스트리밍 응답에서 JSON 직접 파싱 (Node.js 전용)
   * 대용량 피드 메모리 효율화
   */
  static async parseStream(readable) {
    if (!IS_NODE) {
      // Edge: 전체 버퍼링
      const reader = readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let off = 0;
      for (const c of chunks) { total.set(c, off); off += c.length; }
      return WasmJsonParser.parse(total);
    }

    // Node.js: 스트림 버퍼링
    const { Readable } = await import('node:stream');
    const nodeStream = Readable.fromWeb ? Readable.fromWeb(readable) : readable;
    return new Promise((resolve, reject) => {
      const chunks = [];
      nodeStream.on('data', c => chunks.push(c));
      nodeStream.on('end', () => {
        try {
          resolve(WasmJsonParser.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) { reject(e); }
      });
      nodeStream.on('error', reject);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmImageProcessor
//  Node.js: @squoosh/lib (WASM 기반)
//  Edge: 기본 메타데이터 분석만 (바이너리 처리 불가)
// ─────────────────────────────────────────────────────────────────────────────
export class WasmImageProcessor {
  static #squoosh = null;
  static #initPromise = null;

  static async #init() {
    if (!IS_NODE) return; // Edge에서는 미지원
    if (WasmImageProcessor.#squoosh) return;
    if (WasmImageProcessor.#initPromise) { await WasmImageProcessor.#initPromise; return; }
    WasmImageProcessor.#initPromise = (async () => {
      try {
        WasmImageProcessor.#squoosh = await import('@squoosh/lib');
      } catch {
        // squoosh 미설치 시 폴백 (sharp 또는 노-op)
        try {
          WasmImageProcessor.#squoosh = { _fallback: 'sharp', sharp: (await import('sharp')).default };
        } catch {
          WasmImageProcessor.#squoosh = { _fallback: 'none' };
        }
      }
    })();
    await WasmImageProcessor.#initPromise;
  }

  /**
   * 이미지 WebP 변환 + 리사이즈 (Node.js 전용)
   * @param {Buffer|Uint8Array} inputBuffer
   * @param {{ width?: number, height?: number, quality?: number }} opts
   * @returns {Promise<{ buffer: Buffer, contentType: string, originalSize: number, outputSize: number }>}
   */
  static async convertToWebP(inputBuffer, opts = {}) {
    await WasmImageProcessor.#init();
    const { width, height, quality = 80 } = opts;
    const originalSize = inputBuffer.byteLength || inputBuffer.length;

    if (!IS_NODE) {
      throw new Error('WasmImageProcessor.convertToWebP: Node.js 전용 기능입니다.');
    }

    const sq = WasmImageProcessor.#squoosh;

    // ── @squoosh/lib 경로 ──
    if (sq && !sq._fallback) {
      const { ImagePool } = sq;
      const pool = new ImagePool(1);
      try {
        const image = pool.ingestImage(Buffer.from(inputBuffer));
        if (width || height) {
          await image.preprocess({ resize: { enabled: true, width: width || undefined, height: height || undefined } });
        }
        await image.encode({ webp: { quality } });
        const encoded = await image.encodedWith.webp;
        const outputBuffer = Buffer.from(encoded.binary);
        return { buffer: outputBuffer, contentType: 'image/webp', originalSize, outputSize: outputBuffer.length };
      } finally {
        await pool.close();
      }
    }

    // ── sharp 폴백 ──
    if (sq && sq._fallback === 'sharp') {
      let pipeline = sq.sharp(Buffer.from(inputBuffer));
      if (width || height) pipeline = pipeline.resize(width || null, height || null, { fit: 'inside' });
      const outputBuffer = await pipeline.webp({ quality }).toBuffer();
      return { buffer: outputBuffer, contentType: 'image/webp', originalSize, outputSize: outputBuffer.length };
    }

    // ── 완전 폴백: 변환 없이 원본 반환 ──
    return { buffer: Buffer.from(inputBuffer), contentType: 'application/octet-stream', originalSize, outputSize: originalSize };
  }

  /**
   * 이미지 메타데이터 추출 (Edge 포함)
   * 이미지 바이너리의 매직바이트로 포맷·크기 판별
   */
  static detectImageMeta(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    // PNG
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const w = (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0;
      const h = (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0;
      return { format: 'png', width: w, height: h, contentType: 'image/png' };
    }
    // JPEG
    if (b[0] === 0xff && b[1] === 0xd8) {
      const dims = WasmImageProcessor.#extractJpegDims(b);
      return { format: 'jpeg', ...dims, contentType: 'image/jpeg' };
    }
    // WebP
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return { format: 'webp', contentType: 'image/webp' };
    }
    // GIF
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      const w = b[6] | b[7] << 8;
      const h = b[8] | b[9] << 8;
      return { format: 'gif', width: w, height: h, contentType: 'image/gif' };
    }
    return { format: 'unknown', contentType: 'application/octet-stream' };
  }

  static #extractJpegDims(b) {
    let i = 2;
    while (i < b.length - 8) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return {};
  }

  /**
   * srcset 최적화용 다중 해상도 생성 (Node.js 전용)
   */
  static async generateResponsiveSet(inputBuffer, breakpoints = [320, 640, 960, 1280]) {
    const results = [];
    for (const w of breakpoints) {
      try {
        const r = await WasmImageProcessor.convertToWebP(inputBuffer, { width: w, quality: 75 });
        results.push({ width: w, ...r });
      } catch (e) {
        console.error(`[WasmImageProcessor] responsive ${w}px 실패:`, e);
      }
    }
    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmCdnOptimizer
//  CDN 캐시 전략 결정 엔진 (TTL, Surrogate-Key, Vary, ETag)
// ─────────────────────────────────────────────────────────────────────────────
export class WasmCdnOptimizer {
  /**
   * 요청 경로·콘텐츠 타입으로 최적 Cache-Control 헤더 결정
   */
  static getCacheStrategy(pathname, contentType = '', statusCode = 200) {
    if (statusCode >= 400) {
      return {
        'Cache-Control': statusCode === 404 ? 'public, max-age=60' : 'no-store',
        'CDN-Cache-Control': 'no-store'
      };
    }

    // 이미지·정적 자산: 1년 immutable
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(\?|$)/i.test(pathname)) {
      return {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000',
        'Vary': 'Accept-Encoding'
      };
    }

    // JS / CSS: 1년 immutable (해시 파일명 전제)
    if (/\.(js|css)(\?|$)/i.test(pathname)) {
      return {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000',
        'Vary': 'Accept-Encoding'
      };
    }

    // HTML 포스트: SWR 전략
    if (contentType.includes('text/html')) {
      const isPost = /\/\d{4}\/\d{2}\/[^/]+\.html$/.test(pathname)
        || !/\.\w+$/.test(pathname); // slug URL 포함
      return {
        'Cache-Control': isPost
          ? 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800'
          : 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
        'CDN-Cache-Control': `public, max-age=${isPost ? 86400 : 3600}`,
        'Vary': 'Accept-Encoding, Accept-Language'
      };
    }

    // JSON (피드 등)
    if (contentType.includes('application/json')) {
      return {
        'Cache-Control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600',
        'CDN-Cache-Control': 'public, max-age=1800',
        'Vary': 'Accept-Encoding'
      };
    }

    return { 'Cache-Control': 'public, max-age=60' };
  }

  /**
   * Surrogate-Key (태그 기반 캐시 무효화) 생성
   * Cloudflare Cache Tags / Fastly Surrogate-Key 호환
   */
  static buildSurrogateKeys(pathname) {
    const keys = ['all'];
    const postMatch = pathname.match(/^\/(\d{4})\/(\d{2})\//);
    if (postMatch) {
      keys.push(`year-${postMatch[1]}`, `month-${postMatch[1]}-${postMatch[2]}`, 'posts');
    } else if (pathname === '/') {
      keys.push('home');
    } else if (!pathname.includes('.')) {
      keys.push('slug-pages');
    }
    return keys.join(' ');
  }

  /**
   * 요청 Accept 헤더로 최적 이미지 포맷 결정
   */
  static negotiateImageFormat(acceptHeader = '') {
    if (acceptHeader.includes('image/avif')) return 'avif';
    if (acceptHeader.includes('image/webp')) return 'webp';
    return 'original';
  }

  /**
   * 응답 헤더 묶음 생성 (ETag 포함)
   */
  static async buildOptimalHeaders(pathname, contentType, content, statusCode = 200) {
    const strategy = WasmCdnOptimizer.getCacheStrategy(pathname, contentType, statusCode);
    const surrogateKey = WasmCdnOptimizer.buildSurrogateKeys(pathname);
    let etag = null;
    if (content && statusCode < 300) {
      try { etag = await WasmHasher.etag(content); } catch {}
    }
    return {
      ...strategy,
      'Surrogate-Key': surrogateKey,
      'Cache-Tag': surrogateKey,          // Cloudflare 호환 별칭
      ...(etag ? { 'ETag': etag } : {}),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WasmDataProcessor
//  HTML 파싱·변환 고속화 (Regex 컴파일 캐싱, 배치 처리)
// ─────────────────────────────────────────────────────────────────────────────
export class WasmDataProcessor {
  // 컴파일된 RegExp 캐시 (isolate 수명 동안 유지)
  static #regexCache = new Map();

  static #getRegex(pattern, flags = 'gi') {
    const key = `${flags}:${pattern}`;
    if (!WasmDataProcessor.#regexCache.has(key)) {
      WasmDataProcessor.#regexCache.set(key, new RegExp(pattern, flags));
    }
    // NOTE: lastIndex를 사용하는 /g 플래그 regex는 공유 금지 — 매번 복제
    const cached = WasmDataProcessor.#regexCache.get(key);
    return new RegExp(cached.source, cached.flags);
  }

  /**
   * HTML에서 특정 태그 내용 일괄 추출 (WASM-like 배치)
   * @param {string} html
   * @param {string[]} tags — ['title', 'meta', 'h1', ...]
   */
  static extractTags(html, tags) {
    const result = {};
    for (const tag of tags) {
      const re = WasmDataProcessor.#getRegex(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      result[tag] = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        result[tag].push({ attrs: m[1].trim(), content: m[2] });
      }
    }
    return result;
  }

  /**
   * 대용량 HTML 배치 텍스트 치환 (Map 기반, 단일 패스)
   * worker.js의 rewriteInternalLinksToSeoSlugs 가속화 버전
   */
  static batchReplaceLinks(html, pathToSlugMap, origin) {
    if (!pathToSlugMap || pathToSlugMap.size === 0) return html;
    // href 속성 단일 패스 치환
    return html.replace(/href=(["'])([^"']+)\1/gi, (full, quote, href) => {
      let pathname;
      let isAbsolute = false;
      try {
        if (href.startsWith('http://') || href.startsWith('https://')) {
          const u = new URL(href);
          if (u.origin !== origin) return full;
          pathname = u.pathname;
          isAbsolute = true;
        } else if (href.startsWith('/')) {
          pathname = href.split('?')[0].split('#')[0];
        } else return full;
      } catch { return full; }

      if (!/^\/\d{4}\/\d{2}\/[^/]+\.html$/.test(pathname)) return full;
      const slug = pathToSlugMap.get(pathname);
      if (!slug) return full;
      return `href=${quote}${isAbsolute ? `${origin}/${slug}` : `/${slug}`}${quote}`;
    });
  }

  /**
   * JSON 직렬화 최적화 (순환 참조 방지 + XSS-safe)
   */
  static safeJsonStringify(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');
  }

  /**
   * 피드 Entry 배치 정규화 (동기, WASM-like 속도)
   */
  static normalizeFeedEntries(rawEntries) {
    const arr = Array.isArray(rawEntries) ? rawEntries : (rawEntries ? [rawEntries] : []);
    const results = [];
    for (const entry of arr) {
      try {
        const title = entry?.title?.$t || '';
        const updated = entry?.updated?.$t || '';
        const altLink = entry?.link?.find?.(l => l.rel === 'alternate');
        if (!title || !altLink) continue;
        let pathname;
        try { pathname = new URL(altLink.href).pathname; } catch { continue; }
        results.push({ title, updated, pathname });
      } catch { /* 손상된 entry 스킵 */ }
    }
    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  export: 통합 초기화 (선택적 워밍업)
// ─────────────────────────────────────────────────────────────────────────────
export async function warmupWasm() {
  await Promise.allSettled([
    WasmJsonParser.parse('{}'),     // simdjson WASM 초기화
    WasmCompressor.gzip('warm'),    // fflate WASM 초기화
  ]);
}

export default {
  WasmHasher,
  WasmCompressor,
  WasmJsonParser,
  WasmImageProcessor,
  WasmCdnOptimizer,
  WasmDataProcessor,
  warmupWasm
};
