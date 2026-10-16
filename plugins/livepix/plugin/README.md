# LivePix 2.0.1

Plugin comunitário para OSC Flow Studio 0.5.x. Cada doação que chega ao LivePix vira um
gatilho de flow. As doações passam pelo **OSC LivePix Dashboard**
(`https://livepix.maned.club`), que recebe o webhook do LivePix, guarda cada doação e
entrega ao plugin em tempo real.

## Instalação

1. Acesse o OSC LivePix Dashboard, crie sua conta e crie um webhook.
2. Na tela do webhook, copie a **URL para o LivePix** e cadastre-a como webhook no painel
   do LivePix (dashboard.livepix.gg). Não mostre essa URL na live nem a envie para
   ninguém: o LivePix não aceita senha em webhooks, então o link é a única proteção.
3. Ainda no dashboard, informe o Client ID e o Client Secret de um aplicativo OAuth do
   LivePix com `payments:read` e `messages:read`. A notificação do LivePix só diz qual
   doação chegou; é com essas credenciais que o dashboard lê valor, nome e mensagem.
4. Clique em **Gerar token** e copie o token (começa com `olp_`). Ele aparece uma vez só.
5. No OSC Flow Studio, abra **Integrações → Install from zip** e escolha
   `io.github.osc-flow-studio.livepix-2.0.1.zip`. Revise e confirme o pacote.
6. Na aba **Conexão**, cole o token. A URL base já vem com `https://livepix.maned.club`.
7. In **Subathon**, select the start date and local time using the calendar field.
   Only donations at or after this instant are eligible. Leave it empty to start
   from the first activation. Requires the Studio build with native date fields.
8. Ative a integração.

## Como as doações chegam

O WebSocket é o caminho principal: a doação dispara assim que o dashboard a confirma no
LivePix. Quando o WebSocket cai, o plugin consulta a API do dashboard no intervalo da aba
**Geral** (10 segundos por padrão) e tenta reconectar sozinho. Depois de cada reconexão,
na ativação e a cada cinco minutos, ele relê todas as doações desde o início do subathon.

Processed IDs are stored in encrypted pages before triggers fire. They no longer expire
after 10,000 donations. Disabling stops all queries and triggers; enabling starts a full
reconciliation from the selected date. Changing the start date retains processed IDs.
Failed state reads stop activation; failed writes leave new IDs available for retry.

Trigger delivery alone does not acknowledge downstream accounting. Use manual recovery
after a flow failure, and the explicit accounting receipt described below to track its
result. IDs already discarded by an older version cannot be recovered from its saved
state. Existing IDs are migrated.

## Recovering donations

Update both the dashboard and this plugin. In the dashboard's Donations tab, select a
search start and choose **Buscar no LivePix** to import payments and messages even when
their webhook never arrived. Saved donations remain available after an interrupted
search. The retry button continues at the failed page while the panel remains open.

Use **Reenviar** for one saved donation, or **Reenviar doações do subathon** to retry all
saved donations since the plugin's configured start. The bulk action uses the plugin's
start date, independently of the dashboard's search filters. The **LivePix: recuperar
doações** flow action performs the same recovery. Normal **sincronizar agora** still
emits only IDs that this plugin has not delivered before.

Prefer the dashboard's bulk button for large histories. It starts background recovery
without waiting inside Studio's 30-second action timeout. If a recovery action reaches
that timeout, its background work may still be running; the stable accounting key
continues to protect CatOPanda totals.

Every retry retains `metadata.eventKey` and applies the plugin's date, currency and
amount filters. Pass that key unchanged to CatOPanda's **Registrar Donate**. Its durable
ledger accepts missing contributions and ignores already-counted IDs. Do not reset the
ledger for recovery. Recovery fires the donation trigger again, so other actions in the
same flow also run again and need their own idempotency if they must not repeat.

Connect **LivePix: confirmar contabilização** directly after **Registrar Donate**:

- `eventKey`: `{{ $trigger.metadata.eventKey }}`
- `accounted`: `{{ $json.accepted || $json.duplicate }}`

The updated CatOPanda LivePix template includes this connection. Existing flows are not
rewritten and need the receipt block added. The dashboard shows **Confirmada pelo fluxo**
only after the receipt is saved. **Sem confirmação** includes failed flows, lost receipts
and older flows without this block; it does not prove the donation was uncounted. If the
receipt fails after accounting, another recovery gets a duplicate result from CatOPanda
and can safely resend the receipt. Confirmation records the first receipt, not a live
query of current Subathon totals after manual corrections or resets.

Dashboard replay requires a connected plugin. Offline requests return an error and are
not queued; the saved donation stays available for the next retry. Importing new
donations also makes them available to the normal API synchronization while the plugin
is running. No production data is deleted by recovery.

## Blocos

Identidade do pacote: `io.github.osc-flow-studio.livepix`; API de plugins 1.
Adicione o catálogo de plugins da comunidade em **Integrações → Sources**
para receber atualizações:

```text
https://github.com/OSC-Flow-Studio/official-community-plugins/releases/latest/download/listing.json
```

| Bloco | O que faz |
|---|---|
| LivePix: doação recebida | Gatilho. Um disparo por doação nova desde o início do subathon, com `metadata.amount` em centavos e, quando houver, nome e mensagem. Filtra por valor mínimo, valor máximo, texto e presença de mensagem. |
| LivePix: sincronizar agora | Ação. Relê o dashboard desde o início do subathon e dispara o que ainda não foi processado. |
| LivePix: ler status | Entrada. Transporte em uso (`websocket`, `polling` ou `offline`), última sincronização e contadores. |

Pass `metadata.eventKey` to the receiving plugin's unique event key. The bundled
CatOPanda template already does this. Update CatOPanda to the build with persistent
ID pages as well; its previous 1,000-key limit could allow older deliveries to count
again. Clearing the deduplication ledger intentionally allows those IDs to count again.

## Atualizando da 1.x

A 2.0.0 não fala mais direto com a API do LivePix. Client ID e Client Secret saem do
plugin e passam a ficar no dashboard; no plugin ficam só a URL base, o token e o início
do subathon. Os tipos dos blocos e o formato do gatilho são os mesmos, então os flows
continuam funcionando. As doações que a 1.2.0 já tinha disparado continuam marcadas como
processadas.

## Segurança

- O token sai da máquina apenas para a URL base configurada, sempre em HTTPS
  (`http://` só é aceito para `localhost`).
- O token fica no cofre criptografado do Studio e abre somente o webhook que o gerou.
  Gerar um novo token no dashboard derruba o anterior na hora.
- Toda requisição tem tempo limite de dez segundos.
