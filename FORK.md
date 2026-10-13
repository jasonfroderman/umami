# Fork notes

This is a fork of `umami-software/umami` that adds HTTP Basic auth in front of the
dashboard while keeping tracking public. All custom work is additive (new files), so
upstream merges should rarely conflict.

## Branches and remotes

| Name | Role | Rules |
|---|---|---|
| `upstream` (remote) | `umami-software/umami` | Read-only. Never push. |
| `origin` (remote) | `jasonfroderman/umami` | Your fork. |
| `master` | Mirror of `upstream/master` (release code) | **Never commit to it.** Only fast-forward. |
| `custom` | `master` + the customizations below | **Deploy to Heroku from this branch.** |
| feature branches | Short-lived work | Branch from `custom`, merge back into `custom`. |

Gotchas:

- Never open a PR or merge a feature branch into `master`. That would put custom code
  on the mirror and break fast-forward syncing. Target `custom` instead. (Polyscope
  defaults PR targets to `master`, so change it.)
- Leave GitHub's default branch as `master` so the "Sync fork" button keeps updating the
  mirror, and always pick `custom` as the base when opening a PR on GitHub.
- `custom` must not track `origin/master`. Set its upstream once, on the first push:
  `git push -u origin custom`.
- Deploy from release tags (`v3.x.y`) on `upstream/master`. `upstream/dev` is
  unreleased work and may contain database migrations.
- `git config rerere.enabled true` is set, so Git remembers conflict resolutions.

## Updating from upstream

```sh
git fetch upstream --tags
git log --oneline master..upstream/master        # what's new? (empty = up to date)

# 1. Fast-forward the mirror
git switch master
git merge --ff-only upstream/master              # fails if master was touched. Stop and investigate.
git push origin master

# 2. Bring it into custom
git switch custom
git merge master                                 # merge, not rebase: no force-push needed
pnpm install                                     # picks up lockfile/dependency changes
pnpm test                                        # includes src/lib/site-gate.test.ts
pnpm build                                       # confirm it builds before deploying

# 3. Ship: pushing custom is the deploy (Heroku auto-deploys it, see below)
git push origin custom
```

If the merge conflicts:

- `pnpm-lock.yaml`: take upstream's (`git checkout --theirs pnpm-lock.yaml`), then
  `pnpm install`.
- `src/proxy.ts` or `src/middleware.ts` added upstream: Next.js runs only one, so merge
  by hand and keep the gate call.
- Anything else: abort with `git merge --abort`, and ask before resolving.

Roll back a bad update: `git reset --hard ORIG_HEAD` right after the merge, or revert the
merge commit once it's pushed.

## Heroku (GitHub integration)

One-time setup in the Heroku dashboard, app, **Deploy** tab:

1. Deployment method: GitHub. Connect `jasonfroderman/umami` (the fork, not upstream).
2. Set the config vars first (see "Basic auth gate"), before the first deploy.
3. Automatic deploys: choose branch **`custom`**, then Enable. Leave "Wait for CI to pass"
   off: the workflows in `.github/workflows` only run on `umami-software/umami`, so there
   are no checks on the fork and the deploy would wait forever.
4. If the app was previously deploying `master`, switch it to `custom`. `master` is the
   upstream mirror and has no gate.

After that, `git push origin custom` deploys. Use "Manual deploy" on the Deploy tab (branch
`custom`) to redeploy without a push, and **Activity**, **Roll back to here** to undo a release.
Pushing `master` should not deploy anything.

## Customizations

| Change | Files |
|---|---|
| HTTP Basic auth gate | `src/proxy.ts`, `src/lib/site-gate.ts`, `src/lib/site-gate.test.ts` |
| This file | `FORK.md` |

Keep this table current when you add customizations. Prefer new files over editing upstream
ones, and use a `custom:` prefix on commit messages so `git log master..custom` shows only
your work.

## Basic auth gate

Heroku config vars (`heroku config:set NAME=value`):

| Var | Purpose |
|---|---|
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | Required. If either is missing, everything non-public returns 503 (fails closed). |
| `APP_SECRET` | Required by Umami. Also used to sign the gate cookie. |
| `TWO_FACTOR_ENCRYPTION_KEY` | Optional. 64-character hex string (`openssl rand -hex 32`). Only needed if you want to turn on Umami's own 2FA for your login. |
| `GATE_ALLOW_API_BEARER=1` | Optional. Lets `/api/*` calls with a Bearer token (API keys, MCP) skip the gate. Off by default. |

How it works:

- **Public without auth** (so tracking works from other sites): `GET /script.js`
  (plus `TRACKER_SCRIPT_NAME` aliases), `GET /recorder.js`,
  `GET /api/websites/:id/recorder`, `POST|OPTIONS /api/send`, `/api/batch`, `/api/record`
  (plus `COLLECT_API_ENDPOINT`).
- **Everything else, including `/api/auth/login`**, needs Basic credentials or the gate cookie.
- The browser sends Basic credentials on page loads. The gate answers with an HttpOnly,
  signed `site_gate` cookie (12h, sliding). The cookie is what covers the app's own
  `fetch()` calls: those send `Authorization: Bearer ...`, which replaces the browser's
  Basic credentials. The cookie is signed with `APP_SECRET` plus the Basic password, so
  changing either one logs everyone out.
- Pages get a Basic prompt on 401. `/api/*` returns a plain 401 so a credentials dialog
  never pops up mid-session.
- Login still has Umami's own username/password and optional 2FA behind the gate.
  Rate limiting is not included (would need to be at the edge).

### Docker

Upstream's `Dockerfile` runs `COPY docker/proxy.ts ./src`, which would overwrite
`src/proxy.ts` and silently remove the gate. That only matters if you build upstream's
Dockerfile yourself. Heroku's Node buildpack never touches it. If you ever move to Docker,
merge the two proxy files first (`docker/proxy.ts` handles `COLLECT_API_ENDPOINT`,
`TRACKER_SCRIPT_NAME`, and `DISABLE_LOGIN` for Docker builds).

## Verifying a deploy

```sh
curl -sI https://a.nff.org/script.js | head -1      # 200, no credentials needed
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://a.nff.org/api/send   # not 401 (400 is fine)
curl -s -o /dev/null -w '%{http_code}\n' https://a.nff.org/                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://a.nff.org/api/auth/login  # 401
curl -s -o /dev/null -w '%{http_code}\n' -u "$USER:$PASS" https://a.nff.org/   # 200
```
