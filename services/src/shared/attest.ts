// NEAR AI response verification: recover the ECDSA signer of a signed call, and check that NEAR AI's attestation
// report binds that signer to a genuine Intel TDX enclave (and, for provider_tee models, NVIDIA GPUs in CC mode).
// NEAR docs: cloud/verification/cloud-api/model-attestations.md, cloud/verification/reference/quote-nonce-signer.md.
// docs/model-choice.md "Verification" says what is and is not checked.
import { X509Certificate, createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const bytes = (h: string) => Buffer.from(String(h).replace(/^0x/i, ''), 'hex');
const digest = (alg: string, ...parts: (Buffer | string)[]) => { const h = createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/** The 0x address (lowercase) whose key made this EIP-191 personal_sign signature over `text`; null if it does not recover. */
export function recoverSigner(text: string, signature: string): string | null {
  try {
    const msg = Buffer.from(text, 'utf8');
    const hash = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
    const sig = bytes(signature);
    const v = sig.length === 65 ? (sig[64] >= 27 ? sig[64] - 27 : sig[64]) : -1;
    if (v !== 0 && v !== 1) return null;
    const pub = secp256k1.Signature.fromBytes(Buffer.concat([Buffer.of(v), sig.subarray(0, 64)]), 'recovered').recoverPublicKey(hash).toBytes(false);
    return '0x' + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString('hex');
  } catch { return null; }
}

// Intel SGX Provisioning Certification Root CA, SHA-256 of its DER
// (https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer, checked 2026-11-09).
const INTEL_ROOT_SHA256 = '44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3';
// Intel's TDX quoting enclave (GET https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity, id TD_QE).
const TD_QE = { mrsigner: 'dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5', isvprodid: 2, attributes: '11000000000000000000000000000000', mask: 'fbffffffffffffff0000000000000000' };
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const p1363 = (key: KeyObject) => ({ key, dsaEncoding: 'ieee-p1363' as const });

/**
 * Throws unless `quoteHex` is a TDX v4 quote whose signature chains to Intel's root: the attestation key signs the
 * quote, Intel's TD quoting enclave vouches for that key, and the PCK certificate chain ends at the pinned Intel root.
 * Returns the 584-byte TD report body.
 * ponytail: TCB level (Intel TCB info for the FMSPC, advisories), PCK revocation (CRLs) and the QE's own TCB level are
 * not checked, so a known-vulnerable but unrevoked platform passes. Upgrade: `@phala/dcap-qvl`
 * `getCollateralAndVerify(quote)` (the verifier NEAR's docs use), require `status` in an accepted set such as
 * ['UpToDate'], and keep the binding checks in checkReport.
 */
export function verifyQuote(quoteHex: string, now = new Date()): Buffer {
  const q = bytes(quoteHex);
  if (q.length < 8 || q.readUInt16LE(0) !== 4 || q.readUInt16LE(2) !== 2 || q.readUInt32LE(4) !== 0x81) throw new Error('not a TDX v4 ECDSA-P256 quote');
  let o = 636; // 48-byte header + 584-byte TD report, then a 4-byte signature-data length
  const take = (n: number) => { const b = q.subarray(o, o + n); if (b.length !== n) throw new Error('truncated quote'); o += n; return b; };
  const sig = take(64), ak = take(64);
  if (take(2).readUInt16LE(0) !== 6) throw new Error('quote lacks QE certification data');
  take(4);
  const qeReport = take(384), qeSig = take(64), qeAuth = take(take(2).readUInt16LE(0));
  if (take(2).readUInt16LE(0) !== 5) throw new Error('quote lacks a PCK certificate chain');
  const certs = (take(take(4).readUInt32LE(0)).toString('utf8').match(PEM) ?? []).map((c) => new X509Certificate(c));
  const root = certs.at(-1);
  if (certs.length !== 3 || root?.fingerprint256 !== INTEL_ROOT_SHA256) throw new Error('PCK chain does not end at the Intel SGX root CA');
  certs.forEach((c, i) => { // leaf, platform CA, root (self-signed)
    const up = certs[Math.min(i + 1, 2)];
    if (!c.checkIssued(up) || !c.verify(up.publicKey)) throw new Error(`PCK chain broken at ${c.subject.replace(/\n/g, ', ')}`);
    if (now < c.validFromDate || now > c.validToDate) throw new Error('PCK chain certificate outside its validity');
  });
  if (!verify('sha256', qeReport, p1363(certs[0].publicKey), qeSig)) throw new Error('QE report not signed by the PCK key');
  if (qeReport.subarray(128, 160).toString('hex') !== TD_QE.mrsigner || qeReport.readUInt16LE(256) !== TD_QE.isvprodid
    || !qeReport.subarray(48, 64).every((b, i) => (b & bytes(TD_QE.mask)[i]) === bytes(TD_QE.attributes)[i])) throw new Error('QE is not Intel\'s TD quoting enclave');
  if (!qeReport.subarray(320, 384).equals(Buffer.concat([digest('sha256', ak, qeAuth), Buffer.alloc(32)]))) throw new Error('QE report does not bind the attestation key');
  const akKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: ak.subarray(0, 32).toString('base64url'), y: ak.subarray(32).toString('base64url') }, format: 'jwk' });
  if (!verify('sha256', q.subarray(0, 632), p1363(akKey), sig)) throw new Error('quote signature invalid');
  return q.subarray(48, 632);
}

/** RTMR3 from the event log (a JSON string or array): SHA-384 extend of every imr-3 event, digests recomputed. */
export function replayRtmr3(eventLog: unknown): Buffer {
  let rtmr = Buffer.alloc(48);
  for (const e of json(eventLog) as any[]) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4); type.writeUInt32LE(e.event_type);
    const d = digest('sha384', type, ':', Buffer.from(e.event, 'utf8'), ':', bytes(e.event_payload ?? ''));
    if (e.digest && !bytes(e.digest).equals(d)) throw new Error(`event log digest mismatch for ${e.event}`);
    rtmr = digest('sha384', rtmr, d);
  }
  return rtmr;
}

export type Report = {
  signing_address: string; signing_algo: string; intel_quote: string; event_log: unknown; request_nonce: string;
  report_data?: string; tls_cert_fingerprint?: string; model_name?: string; nvidia_payload?: string; info: { tcb_info: unknown };
};

/**
 * Throws unless one NEAR-operated report is genuine (verifyQuote), not a debug TD, and binds its ECDSA signing address
 * and our nonce in the quote's report data, with the measured config (MRCONFIGID) and runtime log (RTMR3) consistent.
 * ponytail: only MRCONFIGID (against app_compose) and RTMR3 (against the event log) are read; MRTD, RTMR0-2,
 * tcb_info.mrtd and os_image_hash are not, and nothing is pinned to known values. So any non-debug TDX VM on genuine
 * Intel hardware (a rented cloud TDX VM included, with any firmware or kernel) whose report the endpoint serves counts.
 * Upgrade: pin MRTD, RTMR0-2 / `os_image_hash` and `compose_hash` per NEAR release.
 */
export function checkReport(r: Report, nonce: string, now = new Date()): void {
  const td = verifyQuote(r.intel_quote, now);
  if (td[120] & 1) throw new Error('TD runs in debug mode');
  const id = bytes(r.signing_address);
  if (r.signing_algo !== 'ecdsa' || id.length !== 20) throw new Error('unsupported signing identity');
  const bound = r.tls_cert_fingerprint ? digest('sha256', id, bytes(r.tls_cert_fingerprint)) : Buffer.concat([id, Buffer.alloc(12)]);
  const reportData = td.subarray(520, 584);
  if (!reportData.equals(Buffer.concat([bound, bytes(nonce)]))) throw new Error('report data does not bind the signer and our nonce');
  if (r.report_data && !bytes(r.report_data).equals(reportData)) throw new Error('report_data differs from the quote');
  if (String(r.request_nonce).toLowerCase() !== nonce.toLowerCase()) throw new Error('echoed nonce differs');
  const compose = json(r.info?.tcb_info)?.app_compose;
  if (typeof compose !== 'string' || !Buffer.concat([Buffer.of(1), digest('sha256', compose), Buffer.alloc(15)]).equals(td.subarray(184, 232))) throw new Error('MRCONFIGID does not match app_compose');
  if (!replayRtmr3(r.event_log).equals(td.subarray(472, 520))) throw new Error('event log does not match RTMR3');
}

/** A check that could not run (network, 5xx): the result is "unknown" (null), not "failed". */
export class Unreachable extends Error {}

export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';

/**
 * Throws unless NVIDIA's public verifier (NRAS, no key) accepts the GPU evidence for our nonce.
 * ponytail: trusts the TLS-authenticated NRAS verdict; the EAT JWT's ES384 signature is not checked against NVIDIA's
 * JWKS (https://nras.attestation.nvidia.com/.well-known/jwks.json) and per-GPU claims (driver/VBIOS versions) are not
 * matched against a policy. Upgrade: verify the JWT with that JWKS and check each submod's claims.
 */
export async function checkGpu(payload: string, nonce: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (String(json(payload)?.nonce).toLowerCase() !== nonce.toLowerCase()) throw new Error('GPU evidence nonce differs');
  let r: Response;
  try { r = await fetchFn(NRAS_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: payload }); }
  catch (e: any) { throw new Unreachable(`NRAS: ${e?.message ?? e}`); }
  if (r.status === 429 || r.status >= 500) throw new Unreachable(`NRAS HTTP ${r.status}`);
  const a: any = await r.json().catch(() => null);
  const jwt = a?.[0]?.[0] === 'JWT' ? String(a[0][1]) : '';
  let claims: any = null;
  try { claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { /* rejected below */ }
  if (claims?.['x-nvidia-overall-att-result'] !== true || String(claims.eat_nonce).toLowerCase() !== nonce.toLowerCase()) throw new Error(`NRAS did not accept the GPU evidence (HTTP ${r.status})`);
}

type Checked = { address: string; algo: string; ok: boolean | null };
type Evidence = { checked_at: string; reports: Checked[] };
export type AttestDeps = { base: () => string; key: () => string; fetch?: typeof fetch; nonce?: () => string; now?: () => Date };
export type Attestation = { attested: boolean | null; attestation_checked_at: string | null };

const GATEWAY = '';
const RETRY_MS = 60_000; // a failed fetch, or a signer missing from a report, refetches at most this often

/**
 * One cache per process: the gateway report (fetched without a model) and each model's NEAR reports (provider=near),
 * each fetched with a fresh nonce, verified, and kept. prefetch() starts both before a completion is sent, so the
 * evidence predates the response it is matched against (NEAR's preflight rule).
 */
export function createAttestor(deps: AttestDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const cache = new Map<string, { at: number; p: Promise<Evidence> }>();

  async function load(model: string | null): Promise<Evidence> {
    const nonce = deps.nonce?.() ?? randomBytes(32).toString('hex');
    const qs = new URLSearchParams({ ...(model ? { model, provider: 'near' } : {}), include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce });
    let r: Response;
    try {
      r = await fetchFn(`${deps.base()}/attestation/report?${qs}`, {
        headers: { accept: 'application/json', 'x-no-aliasing': 'true', ...(deps.key() ? { authorization: `Bearer ${deps.key()}` } : {}) },
      });
    } catch (e: any) { throw new Unreachable(`attestation report: ${e?.message ?? e}`); }
    if (!r.ok) throw new Unreachable(`attestation report HTTP ${r.status}`);
    const body: any = await r.json();
    // Model reports from third-party TEEs (e.g. GLM via Tinfoil) carry no Intel quote; they never sign provider_tee.
    const reports: Report[] = model ? (body.model_attestations ?? []).filter((m: any) => m?.intel_quote) : [body.gateway_attestation];
    const checked = await Promise.all(reports.map(async (rep): Promise<Checked> => {
      const who = { address: String(rep?.signing_address).toLowerCase(), algo: String(rep?.signing_algo) };
      try {
        checkReport(rep, nonce, deps.now?.() ?? new Date());
        if (model) {
          if (rep.model_name && rep.model_name !== model) throw new Error(`report is for ${rep.model_name}`);
          if (!rep.nvidia_payload) throw new Error('no GPU evidence');
          await checkGpu(rep.nvidia_payload, nonce, fetchFn);
        }
        return { ...who, ok: true };
      } catch (e: any) {
        console.warn(`[attest] ${model ?? 'gateway'} report for ${who.address} not accepted: ${e?.message ?? e}`);
        return { ...who, ok: e instanceof Unreachable ? null : false };
      }
    }));
    return { checked_at: (deps.now?.() ?? new Date()).toISOString(), reports: checked };
  }

  function evidence(source: string, refresh = false): Promise<Evidence> {
    const hit = cache.get(source);
    if (hit && !(refresh && Date.now() - hit.at > RETRY_MS)) return hit.p;
    const p = load(source || null);
    const entry = { at: Date.now(), p };
    if (hit) {
      // A refresh: the evidence held so far stays until the new evidence is in (a failed refresh changes nothing), and
      // the next refresh waits RETRY_MS either way.
      hit.at = entry.at;
      p.then(() => { const cur = cache.get(source); if (!cur || cur === hit) cache.set(source, entry); }, () => {});
      return p;
    }
    cache.set(source, entry);
    p.catch(() => { setTimeout(() => { if (cache.get(source) === entry) cache.delete(source); }, RETRY_MS).unref?.(); });
    return p;
  }

  // NEAR: the signer must match a retained verified report. Instances of a model share one key, so several verified
  // reports naming it are still that one signer; none verified is unverified.
  const decide = (ev: Evidence, address: string): boolean | null => {
    const same = ev.reports.filter((r) => r.address === address.toLowerCase() && r.algo === 'ecdsa');
    return same.some((r) => r.ok === true) ? true : same.some((r) => r.ok === null) ? null : false;
  };

  return {
    /** Start fetching the evidence a signature from this model will be matched against. Never throws. */
    prefetch(model: string) { evidence(GATEWAY).catch(() => {}); evidence(model).catch(() => {}); },
    /** true: the signer is bound to a verified report; false: it is not; null: the evidence could not be fetched. */
    async attest(kind: string | null, model: string, address: string): Promise<Attestation> {
      const source = kind === 'gateway' ? GATEWAY : kind === 'provider_tee' ? model : null;
      if (source === null) return { attested: false, attestation_checked_at: null };
      try {
        let ev = await evidence(source), a = decide(ev, address);
        // Keys change when an enclave is redeployed: a signer missing from an older report triggers one fresh fetch.
        if (a !== true) { const fresh = await evidence(source, true).catch(() => ev); if (fresh !== ev) { ev = fresh; a = decide(ev, address); } }
        return { attested: a, attestation_checked_at: ev.checked_at };
      } catch {
        return { attested: null, attestation_checked_at: null };
      }
    },
  };
}
