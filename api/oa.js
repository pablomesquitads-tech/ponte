// api/oa.js
// Busca de versão gratuita e legal, no mesmo mecanismo da extensão Unpaywall:
//   1. descobrir o DOI do artigo (no próprio link ou nas metatags da página, como
//      citation_doi e dc.identifier, que a extensão lê no navegador);
//   2. consultar a API do Unpaywall (api.unpaywall.org/v2/{doi}), que indexa
//      repositórios, PubMed Central, preprints e artigos abertos nas editoras;
//   3. usar a "best_oa_location" (a versão aberta mais próxima da publicada).
// Reserva: Europe PMC, para textos completos no PMC que o Unpaywall não marcou.
//
// GET /api/oa?doi=10.xxxx/yyy   ou   GET /api/oa?url=https://editora/artigo
// Resposta: { doi, oa: { url, pdf, host, hostType, version, license, status, source } | null }

// O Unpaywall exige um e-mail de contato em cada consulta. Defina UNPAYWALL_EMAIL
// nas variáveis de ambiente do projeto na Vercel; sem ela, usa um endereço genérico.
const EMAIL = process.env.UNPAYWALL_EMAIL || 'ponte-app@users.noreply.github.com';
const UA = 'Ponte/1.0 (busca de acesso aberto)';
const DOI_RE = /^10\.\d{4,9}\/[-._;()/:<>#A-Za-z0-9]+$/;

function cleanDoi(d) {
  d = String(d || '').trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  try { d = decodeURIComponent(d); } catch (_) {}
  // Sufixos de página que não fazem parte do DOI (/full, /abstract, /pdf, /epdf...).
  d = d.replace(/\/(full|abstract|pdf|epdf|pdfdirect|html|references|figures|summary|meta)(\/.*)?$/i, '');
  d = d.replace(/[.,;]+$/, '');
  return DOI_RE.test(d) ? d : null;
}

// Mesmas regras de domínio público usadas no front-end: sem IP, porta, credenciais
// ou nomes de rede interna (evita usar a função como ponte para a rede da Vercel).
function publicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  if (/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|example|invalid|onion)$/i.test(h)) return null;
  if (!/^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/i.test(h)) return null;
  u.protocol = 'https:';
  return u;
}

// DOI embutido no endereço: /doi/10.xxxx/..., ?doi=..., e o padrão da Nature
// (/articles/s41586-021-03819-2 = 10.1038/s41586-021-03819-2).
function doiFromUrl(u) {
  let path = u.pathname + u.search;
  try { path = decodeURIComponent(path); } catch (_) {}
  const m = path.match(/(10\.\d{4,9}\/[^\s?#&"']+)/);
  if (m) return cleanDoi(m[1]);
  if (/(^|\.)nature\.com$/i.test(u.hostname)) {
    const n = u.pathname.match(/\/articles\/([a-z0-9.-]+)/i);
    if (n) return cleanDoi('10.1038/' + n[1]);
  }
  return null;
}

async function fetchText(url, ms, maxBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!r.ok || !r.body) return null;
    // Lê só o começo da página: as metatags ficam no <head>.
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    while (out.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(out)) break;
    }
    try { reader.cancel(); } catch (_) {}
    return out;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Metatags lidas pela extensão: citation_doi, dc.identifier, prism.doi, bepress_citation_doi.
function doiFromHtml(html) {
  if (!html) return null;
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const name = (tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!name || !/^(citation_doi|dc\.identifier|dcterms\.identifier|prism\.doi|bepress_citation_doi|eprints\.doi)$/i.test(name)) continue;
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    const d = content && cleanDoi(content.replace(/^.*?(10\.\d{4,9}\/)/, '$1'));
    if (d) return d;
  }
  return null;
}

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function unpaywall(doi) {
  const d = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi).replace(/%2F/gi, '/')}?email=${encodeURIComponent(EMAIL)}`, 6000);
  const b = d && d.is_oa && d.best_oa_location;
  if (!b || !(b.url_for_pdf || b.url_for_landing_page || b.url)) return null;
  // Nome do local para exibir: evita "doi.org" quando o PDF revela o repositório real.
  let host = '';
  for (const x of [b.url_for_landing_page, b.url, b.url_for_pdf]) {
    try { const h = new URL(x).hostname.replace(/^www\./, ''); if (h && h !== 'doi.org') { host = h; break; } if (!host) host = h; } catch (_) {}
  }
  return {
    url: b.url_for_landing_page || b.url || b.url_for_pdf,
    pdf: b.url_for_pdf || null,
    host,
    hostType: b.host_type || null,          // publisher | repository
    version: b.version || null,             // publishedVersion | acceptedVersion | submittedVersion
    license: b.license || null,
    status: d.oa_status || null,            // gold | hybrid | bronze | green
    source: 'Unpaywall'
  };
}

async function europePmc(doi) {
  const q = encodeURIComponent(`DOI:"${doi}"`);
  const d = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&resultType=lite&pageSize=1`, 5000);
  const r = d && d.resultList && d.resultList.result && d.resultList.result[0];
  if (!r || !r.pmcid || r.inEPMC !== 'Y') return null;
  return {
    url: `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/`,
    pdf: null,
    host: 'pmc.ncbi.nlm.nih.gov',
    hostType: 'repository',
    version: null,
    license: null,
    status: 'green',
    source: 'Europe PMC'
  };
}

// PubMed (pubmed.ncbi.nlm.nih.gov/12345678/): converte o PMID em DOI pelo Europe PMC.
async function doiFromPubmed(u) {
  if (!/^pubmed\.ncbi\.nlm\.nih\.gov$/i.test(u.hostname)) return null;
  const pmid = (u.pathname.match(/^\/(\d{1,9})\/?$/) || [])[1];
  if (!pmid) return null;
  const d = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${pmid}%20AND%20SRC:MED&format=json&resultType=lite&pageSize=1`, 5000);
  const r = d && d.resultList && d.resultList.result && d.resultList.result[0];
  return r && r.doi ? cleanDoi(r.doi) : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  let doi = null;
  if (typeof req.query.doi === 'string') {
    doi = cleanDoi(req.query.doi);
    if (!doi) return res.status(400).json({ error: 'Formato de DOI inválido.' });
  } else if (typeof req.query.url === 'string' && req.query.url.length <= 2048) {
    const u = publicHttpsUrl(req.query.url);
    if (!u) return res.status(400).json({ error: 'Endereço inválido.' });
    doi = doiFromUrl(u) || (await doiFromPubmed(u)) || doiFromHtml(await fetchText(u.toString(), 5000, 400000));
    if (!doi) return res.status(200).json({ doi: null, oa: null });
  } else {
    return res.status(400).json({ error: 'Informe doi ou url.' });
  }

  const oa = (await unpaywall(doi)) || (await europePmc(doi));
  return res.status(200).json({ doi, oa });
}
