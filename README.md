# Vibe 💬

App de mensagens em tempo real (estilo WhatsApp) — web, mobile e servidor num monorepo. Chat com WebSocket, chamadas de áudio/vídeo por WebRTC, upload de mídia, stickers com remoção de fundo por IA e um esquema de "criptografia" ponta a ponta.

Este README cobre duas coisas: **o que já funciona** e **o que precisa ser corrigido antes de ter usuários reais**. A segunda parte existe porque o repositório é **público no GitHub** e contém, hoje, credenciais reais expostas e uma falha de autenticação que permite se passar por qualquer usuário — ver [Segurança — antes de tudo](#-segurança--antes-de-tudo) logo abaixo.

---

## 🚨 Segurança — antes de tudo

### 🔴 Credenciais reais expostas no código-fonte público

`server/src/upload.js` (linhas 11-13) tem uma chave real do Cloudinary como valor padrão, embutida no código:

```js
cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? 'du2lsurb1',
api_key:    process.env.CLOUDINARY_API_KEY    ?? '881134422677227',
api_secret: process.env.CLOUDINARY_API_SECRET ?? '_KVw7rUuPQHMc2hFqQ-0_d37li4',
```

Qualquer pessoa que veja o repositório (ele é público) tem acesso de API à sua conta Cloudinary — pode subir, listar ou apagar arquivos, e isso pode gerar custo na sua conta.
→ **Ação imediata:** revogar/regenerar essa chave no painel do Cloudinary, remover os valores literais do código (deixar só `process.env.CLOUDINARY_...`, sem fallback) e configurar a chave nova via `.env`/variável de ambiente no servidor de produção.

### 🔴 Arquivo `sair` na raiz — dump de senhas de usuários reais

O arquivo `sair` (commitado desde o primeiro commit, `c4b06d4`) é a saída de uma consulta SQL com e-mail e **hash de senha (bcrypt)** de usuários reais, incluindo `wasgba@live.com`.
→ **Ação imediata:** apagar o arquivo e, como ele está no histórico desde o commit inicial, considerar reescrever o histórico do repositório (`git filter-repo` ou similar) — só apagar num commit novo não remove do histórico público. Depois, trocar a senha desses usuários por precaução, já que o hash ficou exposto.

### 🔴 Autenticação do WebSocket não verifica identidade nenhuma

O login por HTTP (`/auth/login`) gera um JWT corretamente. Mas o chat em si roda todo por WebSocket, e a conexão WebSocket **nunca confere esse JWT**. O evento `auth` do WebSocket (`server/src/handlers/handlers_index.js`, função `auth`) recebe `{ userId, name, avatarUrl }` do cliente e simplesmente **confia** no `userId` informado — não valida contra nenhum token.

Na prática: qualquer pessoa pode abrir uma conexão WebSocket direto (sem passar pelo login) e mandar `{ event: 'auth', userId: '<qualquer id>', name: 'x' }` para assumir a identidade de outro usuário — ler conversas, contatos, mandar mensagens em nome dele. Os IDs de usuário são gerados com `Math.random()` (`db_index.js`, função `generateId`), não são criptograficamente difíceis de adivinhar, e — pior — vários já vazaram publicamente no arquivo `sair` citado acima.
→ **Correção:** o evento `auth` do WebSocket precisa validar o JWT recebido do cliente (mandar o token no payload do evento `auth` e chamar `jwt.verify` no servidor, como já é feito nas rotas HTTP) em vez de confiar no `userId` enviado.

### 🟠 "Criptografia ponta a ponta" tem uma porta dos fundos

O app gera um par de chaves RSA no cliente (`useCrypto.js`) e cifra mensagens — até aí, é E2E de verdade. Mas a chave privada também é enviada para o servidor como "escrow" (`/api/keys/register`), cifrada com uma `MASTER_KEY` que **também tem um valor padrão hardcoded** (`server/src/index.js`, linha 24: `'vibe_master_key_troca_em_producao_32c'`). Existe uma rota `POST /api/admin/decrypt` que decifra a chave privada de qualquer usuário só conferindo `adminPassword === process.env.ADMIN_PASSWORD` — sem limite de tentativas, sem log além de um `console.warn`.

Isso significa que a "criptografia ponta a ponta" pode ser desfeita por quem tiver a senha de admin (ou, sem `.env` configurado, pela senha padrão hardcoded). Não é uma falha de implementação — é uma decisão de design que contradiz o que a função promete ao usuário.
→ **Decisão a tomar:** ou remove o escrow/rota de admin e assume que E2E de verdade significa que nem o servidor recupera a chave (perda de dispositivo = perda de histórico, a menos que sincronize via `sync_*` entre sessões ativas, que já existe), ou deixa de chamar isso de "ponta a ponta" e documenta pro usuário que o servidor consegue acessar o conteúdo mediante ordem judicial/senha de admin.

---

## ✅ Funcionalidades existentes

### Conta e sessão
- Cadastro/login por e-mail e senha (bcrypt + JWT, expira em 30 dias).
- Login por telefone com código de verificação — **hoje o código só é impresso no console do servidor**, não existe integração real com provedor de SMS (ver pendências).
- Sincronização de sessão entre dispositivos por código de 6 dígitos (`sync_authorize`/`sync_confirm`/`sync_transfer`), incluindo transferência da chave privada e histórico local.
- Dependências de login social (Google/GitHub via Passport) estão no `package.json` do servidor, mas **não há nenhuma rota nem tela que as use** — é código morto, não uma funcionalidade quebrada.

### Chat (tempo real via WebSocket)
- Conversas diretas e em grupo, mensagens de texto/mídia, com status `sent` → `delivered` → `read`.
- Edição de mensagem (janela de 15 minutos, com histórico de versões salvo) e exclusão (para mim / para todos).
- Indicador de "digitando...", presença online/offline propagada aos contatos, fila de mensagens offline (entrega quando o usuário volta, expira em 7 dias).
- Sugestão automática de "adicionar aos contatos" quando alguém sem ser contato manda mensagem pela primeira vez.
- Reconexão automática do WebSocket no cliente com backoff exponencial.

### Chamadas de voz e vídeo
- Sinalização WebRTC completa por WebSocket (`call_offer`/`call_answer`/`call_ice`/`call_reject`/`call_end`/`call_busy`), implementada tanto no client web quanto no mobile (`react-native-webrtc`).

### Mídia
- Upload de imagem/áudio/vídeo (até 100 MB) com envio para Cloudinary.
- Geração de figurinhas (stickers) removendo o fundo da imagem via `rembg` (Python) — ver pendência de infraestrutura abaixo.
- Picker de emoji (`@emoji-mart`) no client web.

### Criptografia (com ressalva de design — ver seção de segurança)
- Geração de par de chaves RSA-OAEP 2048 no navegador, mensagens cifradas com AES-256-GCM + RSA híbrido antes de sair do cliente.

### Mobile (Expo / React Native)
- Telas de boas-vindas, login (e-mail e telefone), verificação, perfil, contatos (com importação de agenda via `expo-contacts`), chat e chamadas.
- Build configurado via EAS (`eas.json`, projeto já registrado com `projectId`), ícones e splash screen definidos, permissões de câmera/microfone/contatos declaradas no `app.json`.

---

## ⚠️ O que falta para ficar 100% funcional

Além dos itens 🔴/🟠 de segurança acima (que devem vir primeiro), há pendências funcionais e de infraestrutura:

### 🟠 Verificação por SMS não é real
`POST /auth/phone/send` gera um código e só faz `console.log` dele — não existe integração com Twilio, Zenvia ou qualquer provedor. Hoje, login por telefone só funciona se quem está testando tiver acesso ao log do servidor.
→ **Correção:** integrar um provedor de SMS real, ou deixar claro que esse fluxo é só para desenvolvimento.

### 🟡 Sticker (remoção de fundo) depende de Python fora do Node
`POST /api/sticker` chama `python3 server/src/rembg_server.py`, que importa `rembg` e `PIL`. Não há `requirements.txt` no repositório nem qualquer configuração de buildpack Python. Como o deploy (Render.com) parece ser só Node (`server/package.json` como entrada), essa rota provavelmente **falha em produção** hoje, a menos que o ambiente já tenha Python + essas libs instaladas manualmente.
→ **Correção:** adicionar `requirements.txt` e configurar o serviço de deploy para instalar Python + dependências, ou mover a remoção de fundo para uma API de terceiros (mais simples de manter) se o objetivo é só ter a função funcionando de forma confiável.

### 🟡 Sem `.env.example` nem README de setup
Não existe nenhum `.env.example` no repositório (nem na raiz, nem em `server/`). Quem clona o projeto não tem como saber quais variáveis configurar sem ler o código-fonte inteiro. Variáveis necessárias (ver lista completa abaixo).

### 🟡 Segredos com fallback hardcoded (além do Cloudinary já citado)
`JWT_SECRET` (`'vibe_dev_secret'`) e `ADMIN_PASSWORD` (sem `.env`, a rota `/api/admin/decrypt` fica inacessível por senha vazia, mas o padrão ainda é frágil) têm valores padrão no código. Isso é aceitável só em desenvolvimento local — em produção, todos precisam vir de variável de ambiente de verdade, sem fallback no código.

### ⚪ Limpeza (não bloqueia, mas vale fazer)
- `server/src/auth.js` — módulo de registro/login duplicado, nunca importado em lugar nenhum (`index.js` reimplementa a mesma lógica inline). Ou remove, ou centraliza um dos dois.
- `better-sqlite3` no `package.json` do servidor — dependência nunca usada (o banco real é Postgres via `pg`).
- `passport`, `passport-google-oauth20`, `passport-github2` — dependências sem nenhuma rota que as use.
- Pasta `uploads/` na raiz do repositório tem arquivos de mídia reais de usuários (imagens, um `.webm`) commitados — deveria estar no `.gitignore` (hoje só `data/`, `dist/`, `.env`, `*.db`, `node_modules/` estão ignorados).
- Sem testes automatizados em nenhum dos três pacotes (`client`, `server`, `mobile`).
- Mensagens de commit como `"fix: api.js sem caracteres inválidos"` seguido de `"fix: corrige api.js sem caracteres extras"` sugerem que vale revisar o `client/src/lib/api.js` e o `mobile/src/lib/api.js` por segurança — parecem ter sido corrompidos e corrigidos às pressas em produção.

---

## 🔧 Variáveis de ambiente necessárias (`server/.env`)

Não existe `.env` nem `.env.example` no repositório — crie `server/.env` com:

```bash
# Banco (Postgres) — use DATABASE_URL OU as 5 variáveis separadas, não os dois
DATABASE_URL=

# Autenticação
JWT_SECRET=            # string aleatória longa, ex.: openssl rand -hex 32
MASTER_KEY=             # idem — usada pra cifrar o escrow de chave privada (ver ressalva de segurança)
ADMIN_PASSWORD=         # senha da rota /api/admin/decrypt

# Cloudinary — REGENERAR essas chaves, as atuais estão expostas publicamente
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

PORT=3001
```

Sem `DATABASE_URL` (ou as variáveis `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASS`), o servidor não consegue criar o schema no boot.

---

## ▶️ Como rodar

### Servidor
```bash
cd server
npm install
npm run dev      # nodemon src/index.js, porta 3001 por padrão
```

### Cliente web
```bash
cd client
npm install
npm run dev       # Vite, aponta pro servidor local automaticamente (localhost)
```

Ou, a partir da raiz do monorepo, `npm install && npm run dev` sobe servidor + client juntos (script `concurrently` do `package.json` raiz).

### Mobile
```bash
cd mobile
npm install
npm start          # abre o Expo — escaneie o QR code ou rode --android / --ios
```

⚠️ O mobile está **hardcoded para o servidor de produção** (`mobile/src/lib/api.js`, `https://vibe-server-dy2z.onrender.com`) — para testar contra o servidor local, edite esse arquivo temporariamente.

---

## 📁 Estrutura

```
vibe/
├── client/                    → Web (React + Vite + Tailwind)
│   └── src/
│       ├── components/        → UI do chat (ChatWindow, CallModal, Sidebar, ...)
│       ├── context/            → ChatContext.jsx — estado global do chat
│       ├── hooks/               → useSocket, useCrypto, useWebRTC, useTheme
│       └── lib/                  → api.js (URL do servidor), utils.js
│
├── mobile/                    → App (Expo / React Native)
│   └── src/
│       ├── screens/             → Welcome, Login, Phone, Verify, Home, Chat, Contacts, Profile
│       ├── components/          → CallModal, IncomingCall, InputBar
│       ├── context/              → ChatContext.jsx
│       └── hooks/useWebRTC.js
│
├── server/                    → API + WebSocket (Node/Express)
│   └── src/
│       ├── index.js             → rotas HTTP, WebSocket, cron de limpeza
│       ├── auth.js               → módulo morto, não usado (ver limpeza)
│       ├── db/db_index.js        → schema Postgres + queries
│       ├── handlers/handlers_index.js → eventos do WebSocket (chat, chamadas, sync)
│       ├── middleware/socketMap.js    → mapa userId → conexões WS ativas
│       ├── upload.js             → Multer + Cloudinary (chave exposta — ver segurança)
│       └── rembg_server.py       → remoção de fundo pra stickers (precisa Python)
│
├── uploads/                    → arquivos temporários (não deveria estar versionado)
├── sair                        → dump de senhas — REMOVER (ver segurança)
└── package.json                → script raiz que sobe client + server juntos
```

---

Feito com 💜 — Vibe
