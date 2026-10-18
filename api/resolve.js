// api/resolve.js
// Função Serverless Vercel para resolução de DOI em URL final canônica da editora

function cleanAndCanonicalize(rawUrl) {
  try {
    let u = new URL(rawUrl);
    let h = u.hostname.toLowerCase();
    let path = u.pathname + u.search;

    // 1. Desembrulha trânsitos intermediários genéricos (ex: redirect_uri, target, url, dest)
    const q = u.searchParams;
    const redir = q.get('redirect_uri') || q.get('redirect_url') || q.get('redirect') || q.get('target') || q.get('url') || q.get('dest');
    if (redir && /^https?:\/\//i.test(redir) && !/(^|\.)(google|facebook|twitter)\./i.test(redir)) {
      return cleanAndCanonicalize(redir);
    }

    // 2. Elsevier / LinkingHub: converte diretamente para ScienceDirect canônico
    if (/linkinghub\.elsevier\.com$/i.test(h) || /(thelancet|cell)\.com$/i.test(h)) {
      const pii = path.match(/(?:pii[\/=]|\/)([BS0-9a-z()\-]{10,25})/i);
      if (pii) {
        const cleanPii = pii[1].replace(/[()\-]/g, '');
        return `https://www.sciencedirect.com/science/article/pii/${cleanPii}`;
      }
    }

    // 3. Força HTTPS para evitar protocolos inseguros
    u.protocol = 'https:';

    // 4. Normalização canônica de subdomínios oficiais de grandes editoras
    if (h === 'nature.com') u.hostname = 'www.nature.com';
    else if (h === 'sciencedirect.com') u.hostname = 'www.sciencedirect.com';
    else if (h === 'tandfonline.com') u.hostname = 'www.tandfonline.com';
    else if (h === 'jstor.org') u.hostname = 'www.jstor.org';
    else if (h === 'springer.com') u.hostname = 'link.springer.com';
    else if (h === 'cambridge.org') u.hostname = 'www.cambridge.org';
    else if (h === 'pnas.org') u.hostname = 'www.pnas.org';
    else if (h === 'science.org') u.hostname = 'www.science.org';
    else if (h === 'scielo.br') u.hostname = 'www.scielo.br';
    else if (h === 'bmj.com') u.hostname = 'www.bmj.com';
    else if (h === 'annualreviews.org') u.hostname = 'www.annualreviews.org';

    return u.toString();
  } catch (_) {
    return rawUrl;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { doi } = req.query;
  if (!doi || typeof doi !== 'string') {
    return res.status(400).json({ error: 'DOI não fornecido.' });
  }

  // Sanitização do DOI (remove prefixos doi.org, https, barras ou pontuações)
  const clean = doi.trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');

  if (!/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/i.test(clean)) {
    return res.status(400).json({ error: 'Formato de DOI inválido.' });
  }

  try {
    // 1. Tenta resolução direta seguindo redirecionamentos HTTP
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const doiUrl = `https://doi.org/${encodeURIComponent(clean).replace(/%2F/gi, '/')}`;
    const response = await fetch(doiUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    let finalUrl = response.url;
    finalUrl = cleanAndCanonicalize(finalUrl);

    return res.status(200).json({ url: finalUrl, doi: clean });
  } catch (err) {
    // 2. Contingência: consulta a API Handle oficial da IDF caso o fetch direto sofra timeout/bloqueio
    try {
      const handleRes = await fetch(`https://doi.org/api/handles/${encodeURIComponent(clean)}`);
      if (handleRes.ok) {
        const data = await handleRes.json();
        const urlItem = data.values && data.values.find(v => v.type === 'URL');
        if (urlItem && urlItem.data && urlItem.data.value) {
          const finalUrl = cleanAndCanonicalize(urlItem.data.value);
          return res.status(200).json({ url: finalUrl, doi: clean });
        }
      }
    } catch (_) {}

    return res.status(502).json({ error: 'Não foi possível resolver o DOI para o site da editora.' });
  }
}
