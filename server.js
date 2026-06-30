import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_BASE = path.join(__dirname, '.sessions');

const app = express();
app.use(express.json());

// CORS — permite chamadas do dashboard Roundfy
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key,x-recovery-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const RECOVERY_SECRET = process.env.RECOVERY_SECRET;
const PORT = process.env.PORT || 3001;

// api_key → { socket, status: 'disconnected'|'connecting'|'qr'|'connected', qr }
const connections = new Map();

// ── Auth state por seller ──────────────────────────────────────────────────

async function getAuthState(api_key) {
  const sessionDir = path.join(AUTH_BASE, api_key);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('files')
      .eq('api_key', api_key)
      .single();
    if (data?.files) {
      for (const [filename, content] of Object.entries(data.files)) {
        fs.writeFileSync(path.join(sessionDir, filename), content);
      }
    }
  }

  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(sessionDir);

  const saveCreds = async () => {
    await originalSaveCreds();
    try {
      // Salva todos os arquivos .json da sessão no Supabase
      const files = {};
      for (const file of fs.readdirSync(sessionDir)) {
        if (!file.endsWith('.json')) continue;
        files[file] = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
      }
      if (!Object.keys(files).length) return;
      const { error } = await supabase.from('whatsapp_sessions').upsert(
        { api_key, files, updated_at: new Date().toISOString() },
        { onConflict: 'api_key' }
      );
      if (error) {
        console.error(`❌ Supabase erro ao salvar sessão ${api_key}:`, error.message, error.details);
      } else {
        console.log(`💾 Sessão salva: ${api_key} (${Object.keys(files).length} arquivos)`);
      }
    } catch (err) {
      console.error(`Erro ao salvar sessão ${api_key}:`, err.message);
    }
  };

  return { state, saveCreds };
}

// ── Conectar seller ────────────────────────────────────────────────────────

async function conectarSeller(api_key) {
  const existing = connections.get(api_key);
  if (existing?.status === 'connected' || existing?.status === 'connecting') return;

  connections.set(api_key, { status: 'connecting', qr: null, socket: null });

  try {
    const { state, saveCreds } = await getAuthState(api_key);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Roundfy Recovery', 'Chrome', '1.0'],
      generateHighQualityLinkPreview: false,
    });

    connections.set(api_key, { status: 'connecting', qr: null, socket });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      const c = connections.get(api_key) || {};

      if (qr) {
        c.qr = qr;
        c.status = 'qr';
        connections.set(api_key, c);
      }

      if (connection === 'open') {
        c.qr = null;
        c.status = 'connected';
        connections.set(api_key, c);
        console.log(`✅ WhatsApp conectado: ${api_key}`);
      }

      if (connection === 'close') {
        c.status = 'disconnected';
        c.qr = null;
        connections.set(api_key, c);

        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          setTimeout(() => conectarSeller(api_key), 5000);
        } else {
          // Deslogado — limpa sessão
          const sessionDir = path.join(AUTH_BASE, api_key);
          fs.rmSync(sessionDir, { recursive: true, force: true });
          supabase.from('whatsapp_sessions').delete().eq('api_key', api_key).then(() => {});
          connections.delete(api_key);
          console.log(`🔴 WhatsApp deslogado: ${api_key}`);
        }
      }
    });
  } catch (err) {
    console.error(`Erro ao conectar ${api_key}:`, err.message);
    connections.set(api_key, { status: 'disconnected', qr: null, socket: null });
  }
}

async function desconectarSeller(api_key) {
  const conn = connections.get(api_key);
  try { if (conn?.socket) await conn.socket.logout(); } catch {}
  const sessionDir = path.join(AUTH_BASE, api_key);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  await supabase.from('whatsapp_sessions').delete().eq('api_key', api_key);
  connections.delete(api_key);
}

// ── Formata número BR ──────────────────────────────────────────────────────

function formatPhone(telefone) {
  const digits = telefone.replace(/\D/g, '');
  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  if (withCountry.length === 12) {
    return `${withCountry.slice(0, 4)}9${withCountry.slice(4)}@s.whatsapp.net`;
  }
  return `${withCountry}@s.whatsapp.net`;
}

async function enviarMensagem(api_key, telefone, mensagem) {
  const conn = connections.get(api_key);
  if (!conn?.socket || conn.status !== 'connected') throw new Error('WhatsApp não conectado');

  // Resolve o JID canônico via onWhatsApp para lidar com variações do 9° dígito BR
  const digits = telefone.replace(/\D/g, '');
  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  let jid = formatPhone(telefone);
  try {
    const [result] = await conn.socket.onWhatsApp(withCountry);
    if (result?.exists && result.jid) jid = result.jid;
  } catch {}

  await conn.socket.sendMessage(jid, { text: mensagem });
}

// ── Cron: a cada minuto verifica sessões ativas ────────────────────────────

cron.schedule('* * * * *', async () => {
  try {
    const { data: sessions } = await supabase
      .from('recovery_sessions')
      .select('*')
      .eq('status', 'active');

    if (!sessions?.length) return;

    const apiKeys = [...new Set(sessions.map((s) => s.api_key))];
    const { data: configs } = await supabase
      .from('recovery_configs')
      .select('*')
      .in('api_key', apiKeys)
      .eq('ativo', true);

    const configMap = Object.fromEntries((configs || []).map((c) => [c.api_key, c]));

    for (const session of sessions) {
      const config = configMap[session.api_key];
      if (!config?.intervalos?.length) continue;

      const conn = connections.get(session.api_key);
      if (!conn || conn.status !== 'connected') continue;

      const tipoDaSessao = session.tipo || 'pendente';
      const intervalosDoTipo = config.intervalos.filter((i) => (i.tipo || 'pendente') === tipoDaSessao);

      if (!intervalosDoTipo.length) {
        await supabase.from('recovery_sessions').update({ status: 'expired' }).eq('id', session.id);
        continue;
      }

      const { data: sent } = await supabase
        .from('recovery_messages_sent')
        .select('minutos')
        .eq('session_id', session.id);

      const sentMinutes = new Set((sent || []).map((s) => s.minutos));
      const minutosDecorridos = (Date.now() - new Date(session.created_at).getTime()) / 60000;

      const todosEnviados = intervalosDoTipo.every((i) => sentMinutes.has(i.minutos));
      if (todosEnviados) {
        await supabase.from('recovery_sessions').update({ status: 'expired' }).eq('id', session.id);
        continue;
      }

      for (const intervalo of intervalosDoTipo) {
        if (sentMinutes.has(intervalo.minutos)) continue;
        if (minutosDecorridos < intervalo.minutos) continue;

        const nomeProduto = config.nome_produto || session.produto || '';
        const mensagem = intervalo.mensagem
          .replace(/{nome}/gi, session.nome || 'cliente')
          .replace(/{valor}/gi, `R$ ${(session.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
          .replace(/{produto}/gi, nomeProduto)
          .replace(/{pix}/gi, session.pix_code || '');

        try {
          await enviarMensagem(session.api_key, session.telefone, mensagem);
          await supabase.from('recovery_messages_sent').insert({
            session_id: session.id,
            minutos: intervalo.minutos,
          });
          console.log(`✓ [${tipoDaSessao}] ${intervalo.minutos}min → ${session.telefone}`);
        } catch (err) {
          console.error(`✗ [${tipoDaSessao}] ${intervalo.minutos}min → ${session.telefone}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Erro no cron recovery:', err.message);
  }
});

// ── Middlewares ────────────────────────────────────────────────────────────

function authAbacate(req, res, next) {
  if (!RECOVERY_SECRET || req.headers['x-recovery-secret'] !== RECOVERY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

function authSeller(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(400).json({ error: 'API key obrigatória' });
  req.apiKey = apiKey;
  next();
}

// ── Rotas WhatsApp (por seller) ────────────────────────────────────────────

app.post('/wa/conectar', authSeller, async (req, res) => {
  const conn = connections.get(req.apiKey);
  if (conn?.status === 'connected') return res.json({ status: 'connected' });
  conectarSeller(req.apiKey);
  res.json({ status: 'connecting' });
});

app.get('/wa/status', authSeller, (req, res) => {
  const conn = connections.get(req.apiKey);
  res.json({ status: conn?.status || 'disconnected', hasQr: !!conn?.qr });
});

app.get('/wa/qr', authSeller, (req, res) => {
  const conn = connections.get(req.apiKey);
  res.json({ qr: conn?.qr || null });
});

app.post('/wa/desconectar', authSeller, async (req, res) => {
  await desconectarSeller(req.apiKey);
  res.json({ ok: true });
});

// ── Rotas recovery (chamadas pelo abacate-main) ────────────────────────────

app.post('/recovery/iniciar', authAbacate, async (req, res) => {
  const { txid, api_key, telefone, nome, valor, produto, pix_code } = req.body;
  if (!txid || !api_key || !telefone) {
    return res.status(400).json({ error: 'txid, api_key e telefone obrigatórios' });
  }

  const { data: config } = await supabase
    .from('recovery_configs')
    .select('ativo')
    .eq('api_key', api_key)
    .single();

  if (!config?.ativo) return res.json({ ok: true, skip: true });

  await supabase.from('recovery_sessions').upsert(
    { txid, api_key, telefone: telefone.replace(/\D/g, ''), nome, valor, produto, pix_code, status: 'active' },
    { onConflict: 'txid' }
  );

  res.json({ ok: true });
});

app.post('/recovery/cancelar', authAbacate, async (req, res) => {
  const { txid } = req.body;
  if (!txid) return res.status(400).json({ error: 'txid obrigatório' });
  // Cancela apenas sessões pendentes (tipo = 'pendente')
  await supabase
    .from('recovery_sessions')
    .update({ status: 'paid', updated_at: new Date().toISOString() })
    .eq('txid', txid)
    .eq('tipo', 'pendente')
    .eq('status', 'active');
  res.json({ ok: true });
});

// Dispara automações para venda paga
app.post('/automation/paid', authAbacate, async (req, res) => {
  const { txid, api_key, telefone, nome, valor, produto, pix_code } = req.body;
  if (!txid || !api_key || !telefone) {
    return res.status(400).json({ error: 'txid, api_key e telefone obrigatórios' });
  }

  const { data: config } = await supabase
    .from('recovery_configs')
    .select('ativo, intervalos')
    .eq('api_key', api_key)
    .single();

  const temAutomacaoPaga = config?.ativo &&
    config?.intervalos?.some((i) => (i.tipo || 'pendente') === 'pago');

  if (!temAutomacaoPaga) return res.json({ ok: true, skip: true });

  // Cria sessão do tipo "pago" — txid único: paid_ + txid original
  const txidPago = `paid_${txid}`;
  await supabase.from('recovery_sessions').upsert(
    { txid: txidPago, api_key, telefone: telefone.replace(/\D/g, ''), nome, valor, produto, pix_code, status: 'active', tipo: 'pago' },
    { onConflict: 'txid' }
  );

  res.json({ ok: true });
});

// ── Config e stats do seller ───────────────────────────────────────────────

app.get('/config', authSeller, async (req, res) => {
  const { data } = await supabase
    .from('recovery_configs')
    .select('*')
    .eq('api_key', req.apiKey)
    .single();
  res.json(data || { ativo: false, intervalos: [], nome_produto: '' });
});

app.put('/config', authSeller, async (req, res) => {
  const { ativo, intervalos, nome_produto } = req.body;
  const { error } = await supabase.from('recovery_configs').upsert(
    { api_key: req.apiKey, ativo: !!ativo, intervalos: intervalos || [], nome_produto: nome_produto || '' },
    { onConflict: 'api_key' }
  );
  if (error) return res.status(500).json({ error: 'Erro ao salvar' });
  res.json({ ok: true });
});

// Retorna qual número está conectado
app.get('/wa/info', authSeller, (req, res) => {
  const conn = connections.get(req.apiKey);
  if (!conn?.socket || conn.status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  const user = conn.socket.user;
  res.json({ numero: user?.id || null, nome: user?.name || null });
});

// Verifica se número existe no WhatsApp
app.post('/test/verificar', authSeller, async (req, res) => {
  const { telefone } = req.body;
  if (!telefone) return res.status(400).json({ error: 'telefone obrigatório' });
  const conn = connections.get(req.apiKey);
  if (!conn?.socket || conn.status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  try {
    const jid = formatPhone(telefone);
    const [result] = await conn.socket.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
    res.json({ numero: telefone, jid, existe: !!result?.exists, output: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disparo de teste: envia mensagem imediata sem esperar cron
app.post('/test/disparar', authSeller, async (req, res) => {
  const { telefone, nome, valor, produto, pix_code } = req.body;
  if (!telefone) return res.status(400).json({ error: 'telefone obrigatório' });

  const conn = connections.get(req.apiKey);
  if (!conn || conn.status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp não conectado para esta conta' });
  }

  const { data: config } = await supabase
    .from('recovery_configs')
    .select('*')
    .eq('api_key', req.apiKey)
    .single();

  const intervalos = (config?.intervalos || []);
  if (!intervalos.length) return res.status(400).json({ error: 'Nenhuma automação configurada' });

  const nomeProduto = config?.nome_produto || produto || 'produto';
  const resultados = [];

  for (const intervalo of intervalos) {
    const mensagem = intervalo.mensagem
      .replace(/{nome}/gi, nome || 'cliente')
      .replace(/{valor}/gi, valor ? `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : 'R$ 0,00')
      .replace(/{produto}/gi, nomeProduto)
      .replace(/{pix}/gi, pix_code || '');

    try {
      await enviarMensagem(req.apiKey, telefone, mensagem);
      resultados.push({ minutos: intervalo.minutos, tipo: intervalo.tipo || 'pendente', ok: true });
    } catch (err) {
      resultados.push({ minutos: intervalo.minutos, tipo: intervalo.tipo || 'pendente', ok: false, erro: err.message });
    }
  }

  res.json({ ok: true, enviados: resultados });
});

app.get('/stats', authSeller, async (req, res) => {
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: sessions } = await supabase
    .from('recovery_sessions')
    .select('status')
    .eq('api_key', req.apiKey)
    .gte('created_at', desde);

  const total = sessions?.length || 0;
  const paid = sessions?.filter((s) => s.status === 'paid').length || 0;
  const active = sessions?.filter((s) => s.status === 'active').length || 0;

  res.json({ total, paid, active, conversao: total > 0 ? ((paid / total) * 100).toFixed(1) : '0.0' });
});

// ── Admin: visão geral de todos os sellers conectados ─────────────────────

app.get('/admin/connections', (req, res) => {
  const list = [];
  for (const [api_key, conn] of connections.entries()) {
    list.push({ api_key, status: conn.status });
  }
  res.json(list);
});

// ── Boot: reconecta todos os sellers com sessão salva ─────────────────────

async function reconectarTodos() {
  const { data: sessions } = await supabase
    .from('whatsapp_sessions')
    .select('api_key');
  for (const { api_key } of (sessions || [])) {
    conectarSeller(api_key).catch((err) =>
      console.error(`Erro ao reconectar ${api_key}:`, err.message)
    );
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Roundfy WhatsApp Recovery na porta ${PORT}`);
  reconectarTodos();
});
