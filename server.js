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
const AUTH_DIR = path.join(__dirname, '.auth_state');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const RECOVERY_SECRET = process.env.RECOVERY_SECRET;
const PORT = process.env.PORT || 3001;

let waSocket = null;
let qrCode = null;
let connectionStatus = 'disconnected';

// ── Auth state: carrega do Supabase no boot, salva de volta a cada update ──
async function setupAuthState() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { data } = await supabase
      .from('whatsapp_auth')
      .select('files')
      .eq('id', 'main')
      .single();
    if (data?.files) {
      for (const [filename, content] of Object.entries(data.files)) {
        fs.writeFileSync(path.join(AUTH_DIR, filename), content);
      }
      console.log('Auth state restaurado do Supabase');
    }
  }

  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const saveCreds = async () => {
    await originalSaveCreds();
    try {
      const files = {};
      for (const file of fs.readdirSync(AUTH_DIR)) {
        files[file] = fs.readFileSync(path.join(AUTH_DIR, file), 'utf-8');
      }
      await supabase
        .from('whatsapp_auth')
        .upsert({ id: 'main', files, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    } catch (err) {
      console.error('Erro ao salvar auth no Supabase:', err.message);
    }
  };

  return { state, saveCreds };
}

// ── Formata número BR para JID do WhatsApp ──
function formatPhone(telefone) {
  const digits = telefone.replace(/\D/g, '');
  const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
  // 12 dígitos = 55 + 2 área + 8 número → insere o 9
  if (withCountry.length === 12) {
    return `${withCountry.slice(0, 4)}9${withCountry.slice(4)}@s.whatsapp.net`;
  }
  return `${withCountry}@s.whatsapp.net`;
}

// ── Conexão Baileys ──
async function conectarWhatsApp() {
  try {
    const { state, saveCreds } = await setupAuthState();
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['Roundfy Recovery', 'Chrome', '1.0'],
      generateHighQualityLinkPreview: false,
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        connectionStatus = 'qr';
        console.log('QR Code disponível em GET /admin/qr');
      }

      if (connection === 'open') {
        qrCode = null;
        connectionStatus = 'connected';
        console.log('✅ WhatsApp conectado!');
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : undefined;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp desconectado. Reconectar:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(conectarWhatsApp, 5000);
        } else {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          supabase.from('whatsapp_auth').delete().eq('id', 'main').then(() => {});
        }
      }
    });
  } catch (err) {
    console.error('Erro ao inicializar WhatsApp:', err.message);
    setTimeout(conectarWhatsApp, 10000);
  }
}

async function enviarMensagem(telefone, mensagem) {
  if (!waSocket || connectionStatus !== 'connected') {
    throw new Error('WhatsApp não conectado');
  }
  await waSocket.sendMessage(formatPhone(telefone), { text: mensagem });
}

// ── Cron: a cada minuto verifica sessões pendentes ──
cron.schedule('* * * * *', async () => {
  if (connectionStatus !== 'connected') return;

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

      const { data: sent } = await supabase
        .from('recovery_messages_sent')
        .select('minutos')
        .eq('session_id', session.id);

      const sentMinutes = new Set((sent || []).map((s) => s.minutos));
      const minutosDecorridos = (Date.now() - new Date(session.created_at).getTime()) / 60000;

      // Todos enviados → marca expirado
      const todosEnviados = config.intervalos.every((i) => sentMinutes.has(i.minutos));
      if (todosEnviados) {
        await supabase.from('recovery_sessions').update({ status: 'expired' }).eq('id', session.id);
        continue;
      }

      for (const intervalo of config.intervalos) {
        if (sentMinutes.has(intervalo.minutos)) continue;
        if (minutosDecorridos < intervalo.minutos) continue;

        const mensagem = intervalo.mensagem
          .replace(/{nome}/gi, session.nome || 'cliente')
          .replace(/{valor}/gi, `R$ ${(session.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
          .replace(/{produto}/gi, session.produto || '')
          .replace(/{pix}/gi, session.pix_code || '');

        try {
          await enviarMensagem(session.telefone, mensagem);
          await supabase.from('recovery_messages_sent').insert({
            session_id: session.id,
            minutos: intervalo.minutos,
          });
          console.log(`✓ ${intervalo.minutos}min → ${session.telefone} (${session.txid})`);
        } catch (err) {
          console.error(`✗ ${intervalo.minutos}min → ${session.telefone}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Erro no cron recovery:', err.message);
  }
});

// ── Middlewares ──
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

// ── Rotas chamadas pelo abacate-main ──

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
    {
      txid,
      api_key,
      telefone: telefone.replace(/\D/g, ''),
      nome,
      valor,
      produto,
      pix_code,
      status: 'active',
    },
    { onConflict: 'txid' }
  );

  res.json({ ok: true });
});

app.post('/recovery/cancelar', authAbacate, async (req, res) => {
  const { txid } = req.body;
  if (!txid) return res.status(400).json({ error: 'txid obrigatório' });

  await supabase
    .from('recovery_sessions')
    .update({ status: 'paid', updated_at: new Date().toISOString() })
    .eq('txid', txid)
    .eq('status', 'active');

  res.json({ ok: true });
});

// ── Rotas do seller (dashboard) ──

app.get('/config', authSeller, async (req, res) => {
  const { data } = await supabase
    .from('recovery_configs')
    .select('*')
    .eq('api_key', req.apiKey)
    .single();
  res.json(data || { ativo: false, intervalos: [] });
});

app.put('/config', authSeller, async (req, res) => {
  const { ativo, intervalos } = req.body;
  const { error } = await supabase.from('recovery_configs').upsert(
    { api_key: req.apiKey, ativo: !!ativo, intervalos: intervalos || [] },
    { onConflict: 'api_key' }
  );
  if (error) return res.status(500).json({ error: 'Erro ao salvar configuração' });
  res.json({ ok: true });
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

  res.json({
    total,
    paid,
    active,
    conversao: total > 0 ? ((paid / total) * 100).toFixed(1) : '0.0',
  });
});

// ── Rotas admin ──

app.get('/admin/status', (req, res) => {
  res.json({ status: connectionStatus, hasQr: !!qrCode });
});

app.get('/admin/qr', (req, res) => {
  res.json({ qr: qrCode });
});

app.post('/admin/desconectar', async (req, res) => {
  try {
    if (waSocket) await waSocket.logout();
  } catch {}
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Roundfy WhatsApp Recovery na porta ${PORT}`);
  conectarWhatsApp();
});
