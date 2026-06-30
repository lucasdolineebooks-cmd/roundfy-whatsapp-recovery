-- Cole esse SQL no Supabase SQL Editor (bgxbhnkbbdcaasufmqai.supabase.co)
-- Dashboard > SQL Editor > New query

CREATE TABLE IF NOT EXISTS whatsapp_auth (
  id text PRIMARY KEY,
  files jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_configs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key text UNIQUE NOT NULL,
  ativo boolean DEFAULT false,
  intervalos jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  txid text UNIQUE NOT NULL,
  api_key text NOT NULL,
  telefone text NOT NULL,
  nome text,
  valor numeric,
  produto text,
  pix_code text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'paid', 'expired')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_messages_sent (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id uuid REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  minutos int NOT NULL,
  sent_at timestamptz DEFAULT now(),
  UNIQUE(session_id, minutos)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_status ON recovery_sessions(status);
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_api_key ON recovery_sessions(api_key);
CREATE INDEX IF NOT EXISTS idx_recovery_messages_session ON recovery_messages_sent(session_id);
