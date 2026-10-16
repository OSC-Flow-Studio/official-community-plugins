# Changelog

## 2.0.1 (2026-09-22)

- Published from `OSC-Flow-Studio/official-community-plugins`. Follow the community
  catalog at
  `https://github.com/OSC-Flow-Studio/official-community-plugins/releases/latest/download/listing.json`;
  the `livepix-plugin` catalog receives no new versions. The OSC LivePix Dashboard moved
  to its own repository.
- Recover missing webhook donations from paginated LivePix payment/message history,
  preserving saved rows across failures and validating provider dates.
- Add dashboard search, individual WebSocket resend, and Subathon history recovery.
  Replays retain the original accounting key and respect the plugin's start date.
- Add an explicit post-accounting receipt action and distinguish confirmed accounting
  from delivery attempts in the dashboard. Include an additive database migration.

- Use Studio's native date and time field for the subathon start, retaining legacy
  date formats and offsets. Fix the malformed start-date and base-URL patterns.
- Reconcile all pages after activation or reconnection without expiring processed
  IDs. Migrate existing IDs into bounded encrypted pages shared by both transports.
- Serialize state changes and stop emission when persistence fails. Preserve IDs for
  retry and report unreadable state instead of starting a new ledger.
- Validate donation, sync, and status outputs through the Studio engine and the
  bundled CatOPanda flow, including replay after restart.

## 2.0.0 (2026-09-21)

- As doações chegam pelo OSC LivePix Dashboard, que recebe o webhook do LivePix e guarda
  cada doação. O plugin não fala mais direto com a API do LivePix.
- WebSocket como caminho principal; consulta à API do dashboard no intervalo configurado
  enquanto o WebSocket estiver fora, com reconexão automática.
- Novo campo **Início do subathon**: só doações a partir dele disparam. Vazio, conta a
  partir da primeira ativação.
- O ID de cada doação processada fica no cofre antes do gatilho disparar. Na ativação, a
  cada reconexão e a cada cinco minutos o plugin relê tudo desde o início do subathon e
  dispara só o que ainda não foi processado.
- Configuração nova: URL base (padrão `https://livepix.maned.club`), token da API e
  intervalo de consulta. Saem Client ID, Client Secret, leitura de mensagens e histórico
  inicial.
- A ação de consulta virou **LivePix: sincronizar agora**; **LivePix: ler status** ganhou
  `transport` e `startAt`. Tipos dos blocos e formato do gatilho preservados.
- Doações já disparadas pela 1.2.0 continuam marcadas como processadas.
- Novo `dashboard/`: OSC LivePix Dashboard (Hono, Prisma, Postgres, Better Auth, React).

## 1.2.0 — 2026-09-12

- Compatibilidade declarada com OSC Flow Studio 0.5.x, API de plugins 1.
- Pacote `io.github.osc-flow-studio.livepix`, ZIP determinístico e SHA-256.
- Catálogo para instalação, atualização e rollback pelo gerenciador de pacotes.
- Requisições OAuth/API canceladas por `ctx.signal` e por `deactivate()`; consultas
  pendentes terminam antes de liberar a instância e persistir o estado final.
- A ação de consulta respeita a configuração desativada.
- Preservados `id=livepix`, tipos dos blocos, chave do cofre e formato de deduplicação
  da versão 1.1.0. Atualizar da 1.1.0 não recria a linha de base.
- Repositório independente do SDK, testes, validação do schema e workflows de CI/release.

## 1.1.0

- Pagamentos e mensagens unidos em um gatilho de doação, com deduplicação pelo comprovante.
- Abas de configuração, histórico inicial opcional e tratamento de limite de requisições.

## 1.0.0

- Primeira integração por consulta à API LivePix.
