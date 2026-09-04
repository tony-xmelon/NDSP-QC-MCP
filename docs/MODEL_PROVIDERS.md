# Model providers and credentials

QC Control uses a local-first, bring-your-own-key (BYOK) model. The standalone
MCP server exposes QC tools; it does not supply a language model or pay for model
usage.

## Product policy

- Free/offline use is provided through local OpenAI-compatible servers such as
  Ollama and LM Studio.
- Cloud use initially uses credentials owned by the person running QC Control.
- A publisher-owned provider key must never be compiled into or distributed
  with a desktop or mobile client.
- A future managed service may keep publisher credentials behind an
  authenticated relay with per-user quotas, rate limits, billing controls, and
  short-lived app sessions.

## Supported desktop providers

### Google AI subscription through Antigravity

Provider ID: `antigravity-cli`

This is the recommended personal Windows path when the user has Google AI Pro
or Ultra. Since June 18, 2026, Google no longer permits consumer Google-account
login through Gemini CLI and directs those users to Antigravity. QC Control
therefore invokes Google's supported Antigravity CLI in headless streaming mode;
Antigravity owns authentication and reuses the Google account selected during
its one-time browser sign-in.

QC Control never reads or copies Antigravity's OAuth tokens. It sends the
bounded conversation/QC context to the local CLI process over streaming JSON
standard input and requires schema-enforced JSON output. The process runs
without a console window during normal chat and inside an isolated workspace.
QC tool requests are returned to QC Control for the same validation, one-action
limit, and temporary-edit review used by every other model provider.

The packaged app additionally offers Antigravity a guarded
`fetch_youtube_reference_audio` tool. It accepts public HTTPS YouTube URLs only,
requires the model to relay an explicit user rights confirmation, limits clips
to 5–120 seconds and 32 MB, prefers Opus/WebM with AAC/M4A fallback, and invokes
FFmpeg in stream-copy mode. The resulting attachment is staged for the next
Antigravity round; the downloaded temporary file is then removed.

Antigravity CLI must be installed and authenticated once. Subscription quota,
availability, model access, and occasional entitlement failures remain governed
by Google. This path is distinct from the public Gemini API and does not turn a
Google AI subscription into general-purpose Gemini API quota.

### OpenAI Responses and local compatible servers

Provider ID: `openai-responses`

The bridge calls `POST /v1/responses`. OpenAI uses a user-supplied key. Loopback
servers can operate without one. Ollama 0.13.3 or later and current LM Studio
releases implement this endpoint, including function tools.

### Google Gemini BYOK

Provider ID: `gemini-openai`

The bridge calls Google's OpenAI-compatible
`POST /v1beta/openai/chat/completions` endpoint and translates QC function-tool
definitions and returned tool calls. The endpoint is fixed to
`https://generativelanguage.googleapis.com/v1beta/openai`; arbitrary hosts cannot
be selected for this provider.

The user creates a Gemini key in Google AI Studio and saves it through
**Settings → Conversational model**. Gemini free and paid tiers use the same
integration; billing and quota belong to the Google project that owns the key.

## Credential storage

Provider secrets are stored in Windows Credential Manager. The credential
account is scoped by provider ID and normalized base URL. Non-secret settings
contain only provider ID, model, base URL, and timeout. Credentials are never
returned to the web UI, written to the settings file, or included in diagnostic
exports.

Environment fallbacks are:

- OpenAI: `QC_OPENAI_API_KEY`, or `OPENAI_API_KEY` only for `api.openai.com`.
- Gemini: `QC_GEMINI_API_KEY`, then `GEMINI_API_KEY`.

Remote endpoints require HTTPS. Plain HTTP is accepted only for loopback model
servers.

## Google browser sign-in and OAuth

Google sign-in and Gemini API billing are separate concerns. Signing in with a
consumer Google account does not make that account's Gemini app subscription or
an implicit personal API allowance available to QC Control. Gemini API quota is
owned by a Google Cloud/Firebase project. A zero-key consumer experience
therefore uses a QC Control-managed project and QC Control owns its shared quota,
abuse exposure, and any resulting charges.

Google also documents an installed desktop OAuth flow for developers accessing
the Gemini API. It launches the system browser, receives the redirect on a
temporary loopback listener, and returns an access token plus (when granted) a
refresh token. The official flow still requires a configured Google Cloud
project, enabled Generative Language API, OAuth client, consent screen, scopes,
and quota project. It is not a substitute for BYOK for arbitrary public users.

OAuth is not the initial Gemini integration. Shipping it publicly requires:

1. A Google Cloud project with the Generative Language API enabled.
2. A Desktop application OAuth client for each platform.
3. A configured external consent screen and any required Google verification.
4. Authorization Code flow with PKCE, random `state`, a loopback redirect, a
   strict redirect timeout, and cancellation handling.
5. Secure refresh-token storage, token rotation/revocation, and a Disconnect
   Google action.
6. A privacy policy describing the requested Google scopes and transmitted QC
   conversation/context data.

OAuth authenticates a Google user but does not make model usage free. Quotas and
billing belong to the project used by the application. For a broadly distributed
app, the supported choices are BYOK or a managed service.

## Provider-account authentication UX

The published UI should present two options:

1. **Continue with Google** — primary when the user has an eligible Google Cloud
   project. Windows opens the system browser; Android uses Google's native
   authorization UI. After consent, QC Control lists projects on which the user
   can consume services, asks the user to select one when there is more than one,
   and sends its ID as the quota project. Gemini usage then consumes that
   project's free or paid API quota.
2. **Use your own Gemini key** — advanced option. A direct Google AI Studio link
   opens the key page; the pasted key remains in the platform credential store.
   The user's Google project owns quota and billing.

The direct Gemini API OAuth adapter cannot consume a Google One AI/Gemini
consumer subscription. Its selected account must have a Cloud project with the
Gemini API enabled and the `serviceusage.services.use` permission. Users who
want subscription-backed access should select the separate `antigravity-cli`
provider; users who want public API access should use OAuth with a quota project
or a Gemini key.

Provider-account login is capability-dependent, not a universal abstraction:

- **Gemini:** OAuth plus an explicitly selected user quota project is supported.
- **OpenAI:** third-party API requests currently use project API keys; Sign in
  with ChatGPT is identity-only and does not grant API credits or API billing.
- **Anthropic:** personal API keys are supported. Workload Identity Federation
  is for configured production workloads, not consumer Claude-account quota.
- **Local models:** no provider account or credential is needed.

### Cross-provider connection policy

The UI uses the same presentation for every provider while honoring the
provider's actual authorization capabilities:

| Provider | Primary connection | Uses the user's API quota? | Fallback |
| --- | --- | --- | --- |
| Gemini subscription | Official Antigravity CLI + Google sign-in | Eligible Antigravity / Google AI plan quota | Gemini API key or project OAuth |
| Gemini API | Google OAuth plus user quota-project selection | Yes, from the selected Cloud project | Gemini auth key |
| OpenAI | No supported delegated API-billing grant currently | No; ChatGPT sign-in is identity-only | OpenAI project API key |
| Anthropic | No published third-party consumer OAuth registration currently | Not through Claude Free/Pro/Max; the official interactive grant is for Anthropic's own `ant` CLI | Claude personal API key |
| Ollama / LM Studio | Local connection | Local compute | None required |

QC Control must never reuse private OAuth client IDs, scrape provider-console
sessions, read credentials belonging to another provider CLI, or imply that a
consumer chat subscription includes public API usage. The `antigravity-cli` adapter
executes Google's supported client and leaves its credential store opaque; it
does not import tokens. Account connection can be added
for OpenAI or Anthropic when that provider publishes and approves a delegated
third-party API authorization flow that conveys the user's API organization or
workspace and bills its quota.

Until then, the OpenAI and Anthropic key flows should still be low-friction:

1. Open the provider's exact API-key page in the system browser.
2. Keep QC Control open on the credential field with concise instructions.
3. Paste once and save in the operating-system credential vault.
4. Test the credential and list/validate available models immediately.
5. Show whether failures mean invalid credentials, missing API billing, exhausted
   quota, or unsupported model access.

### Android Google project path

Use Google's native authorization libraries rather than a loopback callback.
Request only the Cloud scopes required to discover/select a quota project and
call Gemini. Store refreshable authorization using platform facilities; never
embed a user key in the APK. Android OAuth clients are tied to package name and
signing-certificate fingerprint. Loopback OAuth redirects must not be used on
Android.

### Windows Google project path

Use Authorization Code with PKCE in the system browser and a temporary loopback
callback. Store the Google refresh token and selected quota-project ID in Windows
Credential Manager; keep access tokens in memory and refresh them automatically.
Every OAuth-authenticated Gemini request includes the selected project as
`x-goog-user-project`. The current UI provides project switching and a local
Disconnect action. Provider-side grant revocation remains a separate future
control and must be labelled differently from removing the locally stored token.

The Google authorization code uses QC Control's public Desktop OAuth client ID.
An installed-app client secret is not considered confidential, but the flow must
still use PKCE and state validation. Publishing beyond test users requires a
configured consent screen and any Google verification required by the requested
Cloud scopes.

The Windows implementation is enabled when the release build is supplied with:

- `QC_GOOGLE_OAUTH_CLIENT_ID` — required Desktop application client ID.
- `QC_GOOGLE_OAUTH_CLIENT_SECRET` — optional installed-app client secret.

These values may be supplied to the build environment so they are compiled into
the published application, or to the process environment during development.
Installed-application client credentials identify the application and are not
treated as confidential; PKCE and state validation protect each authorization
attempt. End users of a publisher-configured release never configure these values.

Personal builds without a publisher client ID expose a guided one-time setup in
Settings. Create a Google OAuth client of type **Desktop app**, then save its
public client ID and optional desktop client secret. QC Control stores this
configuration in Windows Credential Manager. A published build should embed the
publisher-owned client ID so ordinary end users never see the setup step.

The implemented flow opens the system browser, receives the callback only on a
random `127.0.0.1` port, exchanges the code, lists active projects, automatically
selects a sole project or asks the user to choose, stores the refresh token and
project in Windows Credential Manager, refreshes access tokens, and sends the
chosen `x-goog-user-project` header on Gemini requests.

### Optional managed path

Users without an eligible provider API project can use local inference, BYOK, or
an optional QC Control-managed service. The managed service is a separate mode;
it must never be silently selected after provider-account login fails.

The managed path must not be enabled until the service has authentication,
per-user quotas, aggregate spend caps, rate limiting, abuse controls, a privacy
policy, and a way to disable service without breaking local/BYOK operation.

## Planned provider boundary

Provider-specific protocol details remain behind the native chat bridge. Each
provider implementation is responsible for endpoint construction, request/tool
translation, response parsing, authentication, and capability reporting. The UI
and QC action guardrails consume one normalized chat response and never receive
the secret itself.

Current protocol adapters are OpenAI Responses, official Antigravity CLI
streaming JSON, Google OpenAI-compatible Chat Completions, Anthropic Messages,
and local OpenAI-compatible Responses. Provider
metadata owns its default model, endpoint editability, credential label, setup
link, pricing link, and onboarding guidance.
