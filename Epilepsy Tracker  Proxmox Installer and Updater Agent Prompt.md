# Epilepsy Tracker: Proxmox Installer and Updater Agent Prompt

Give this prompt to the coding agent after it has the **Epilepsy Tracker: Technical Specification** and **Epilepsy Tracker: AI Coding Agent Prompt**, both v2.0, in the application’s GitHub repository. This prompt selects the **native Debian LXC** deployment option from the specification. It asks the agent to implement the scripts in the repo, not to run them on a live Proxmox host or push changes without authorization.

Implementation references: [Proxmox container CLI (`pct`)](https://pve.proxmox.com/pve-docs/pct.1.html), [Proxmox template manager (`pveam`)](https://pve.proxmox.com/pve-docs/pveam.1.html), [Node.js release support](https://nodejs.org/en/about/previous-releases), and [SQLite Online Backup API](https://sqlite.org/backup.html).

```text
Implement a repository-owned installer and updater for Seizure Diary. The
installer must provision a fresh unprivileged Debian LXC on Proxmox VE, install
all required packages including Git inside the container before cloning, build
the real application, and start it under systemd. Install the management
command `seizure-diary update` inside the container. Do not require Docker,
Docker nesting, a privileged container, or preinstalled guest Git/Node.

Inspect the repository first. Read the v2.0 application documents and identify
the real package manager, Node engine, locked dependencies, build/start/test
scripts, migration mechanism, first-admin CLI, database path and health check.
Use those actual interfaces. If a necessary interface is missing, implement it
consistently with the app and test it, or report the exact blocker. Do not ship
placeholders that appear to install or update successfully.

DELIVERABLES AND COMMANDS
- `deploy/proxmox/install.sh`: Proxmox-host entry point using pct/pveam. It
  provisions the guest and injects/runs a reviewed guest installer.
- `deploy/proxmox/install-guest.sh`: Guest bootstrap for the fresh LXC;
  idempotent on the same app instance if safely restartable after failure.
  This can also support installing into an existing dedicated, compatible LXC
  when the operator explicitly chooses that path.
- `deploy/proxmox/seizure-diary`: Installed as a root-owned executable at
  `/usr/local/bin/seizure-diary`. Minimum subcommands: `update`, `status`,
  and `version`; expose documented `bootstrap-admin` and `backup` commands
  or delegate to the actual application/operator tools. `update --check`
  reports installed and upstream revisions without rebuilding or deploying.
- Add systemd unit(s), sample non-secret config, and a step-by-step README or
  `deploy/proxmox/README.md`. Add shell syntax/lint and automated tests for
  safe install/update paths. Make scripts executable in the repo.
- Document `seizure-diary update` from a guest console and
  `pct exec <CTID> -- /usr/local/bin/seizure-diary update` from the host.
  State which commands require guest/host administrator permissions.

PROXMOX HOST ENTRY POINT
1. Validate privilege, that pct and pveam are usable, and that the selected
   Proxmox VE release and Debian template are supported. Offer documented flags
   or prompts for CTID, hostname, template or template storage, rootfs storage,
   bridge, IP/prefix/gateway or DHCP, optional VLAN, DNS, CPU, RAM and disk.
   Use modest defaults (e.g. 1 vCPU, 2 GiB RAM, 12 GiB disk) as starting values;
   never assume a storage ID or bridge exists. Validate selected storage can
   hold the requested content and that the CTID is unused. Discover/download
   the compatible official template when needed; never guess archive names.
2. Show an install summary before provisioning. Provide `--dry-run` that
   performs no changes and cannot download, start, or create anything.
   On confirmation, create the unprivileged guest, set boot-on-host-start
   as documented, start it, and run the staged guest bootstrap with pct.
   Check that the guest has working outgoing DNS and internet access for apt
   and Git/package downloads. Do not modify host packages, host firewall,
   Proxmox cluster configuration, port forwarding or reverse-proxy settings.
   Never delete/reuse an existing CTID. On failure explain the partial state
   and how to resume or clean up manually; no automatic pct destroy.
3. Start from a verified copy of the installer bundle. Document a route that
   works when the Proxmox host has no Git: obtain the installer files on an
   authenticated workstation from a reviewed Git ref, verify the bundle, and
   transfer them to the host using the operator’s existing access. Do not
   require root to execute a bare `curl | bash` or blindly trust an unreviewed
   moving branch. Record the installer and deployed source revision.

GUEST BOOTSTRAP AND PRIVATE REPO ACCESS
1. Bootstrap with apt on the supported Debian template. Explicitly install
   `git`, `ca-certificates`, `curl`, `openssh-client`, `sqlite3`, and all other
   utilities your scripts actually use (including the provider of `flock`,
   if used). Install a supported, application-compatible Node.js LTS and the
   repository’s package manager at a pinned version. Use signed Debian/package
   sources or verify official release checksums/signatures. Install native
   module build prerequisites such as `build-essential` and `python3` if the
   supported SQLite/Argon2 dependency set needs them, and test on the actual
   Debian base instead of assuming prebuilt binaries exist. Check Git, Node,
   package manager, SQLite driver and runtime versions before building;
   maintenance of those prerequisites should be explicit and documented.
2. Support public HTTPS clone and private GitHub repo access via a repo-scoped,
   read-only SSH deploy key. Document how an operator adds the guest’s public
   key in GitHub without exporting the private key. For a brand-new guest,
   provide a clear two-step pause/resume: guest bootstrap generates or
   locates the key, shows only the public key, and exits or waits safely until
   the operator grants access; resume uses that same CTID/key/repo without
   recreating the container. Batch mode must fail cleanly with the resume
   command if access is not configured. Do not create a GitHub key/account
   remotely on the operator’s behalf.
3. Use strict SSH host-key verification against a separately trusted GitHub
   fingerprint. Keep the deploy private key 0600 and accessible only to the
   deployment identity, not the running web app. Do not put credentials in
   URLs, command arguments, source control, logs or the service environment.
   Validate access before changing installed releases. Accept only supported
   GitHub HTTPS/SSH repository URL forms and validated refs, not arbitrary Git
   transports, helper protocols, shell strings or local repo paths in production.
4. Use a dedicated non-root service identity and, if needed, a separate
   unprivileged deployment/build identity. Build and run package scripts as
   an unprivileged identity with no diary DB or service-secret access; do not
   build as root. Use the lockfile (`npm ci` if npm is used, or the frozen
   equivalent), and run the repo’s real production build and smoke checks.
   Keep deployed releases separate from `/var/lib/seizure-diary` (SQLite),
   `/etc/seizure-diary` (configuration), and protected backup storage.
5. Install and enable a hardened systemd service using stable paths for the
   current release, runtime and database. Only the service may write the
   app-data path. Keep secrets/config and the DB out of the web root and Git
   checkout. Use the app’s real production migration/bootstrap entry points
   and a non-sensitive readiness route. Never seed real or demo diaries or
   create a default admin password. After install, show next steps for the
   guest-local admin bootstrap, private HTTPS proxy and starting a family
   account. Restrict the backend to a private proxy path (e.g. loopback with
   a same-guest proxy, or a guest firewall allowing only the private external
   proxy). Document and verify LAN/WireGuard ingress and client-trusted TLS;
   never expose the private service to the internet or weaken login for testing.

UPDATE TRANSACTION
1. Serialize with a lock outside release paths. Check disk space, configuration,
   repository access and recorded deployed revision. Fetch only the configured
   trusted branch/release from the configured remote. Resolve the exact
   commit; automatically deploy only a forward update from the currently
   installed revision. Refuse changed remotes, unexpected divergence or
   rewritten history and provide operator guidance. Do not use `git reset
   --hard` or mutate the running checkout. If the deployed and fetched commit
   match, exit successfully without reinstall, rebuilding or restarting.
2. Stage the target in a separate release directory. Use the lockfile and
   build/test before touching the live release, SQLite or systemd. Rebuild
   when deploying a new source revision; skip only when using an explicitly
   verified artifact for the same commit, lockfile, runtime and architecture.
   Verify required runtime/ABI changes in staging. If dependencies or build
   fail, leave the current site and DB untouched and exit nonzero.
3. Immediately before cutover, prevent new writes and drain in-flight work
   (stopping the old service is acceptable). Create and verify a consistent
   SQLite snapshot through the supported backup API/SQLite CLI `.backup` or
   `VACUUM INTO`. Never copy only a live WAL-mode `.sqlite3` file. Keep backup
   staging permissions restrictive and follow the application's encryption/
   retention rules; abort the update if the required verified backup cannot be
   made. Preserve settings, credentials and all members' diaries. Protect
   secrets in env/logs and document how to obtain encrypted backup credentials
   without putting them in Git or passing them as process arguments.
4. Run versioned migrations under a write fence, switch the active release
   atomically (e.g. replace a symlink on the same filesystem), and start the
   new systemd service. Wait for a bounded readiness check that verifies the
   DB schema and deployed revision but returns no health-data records. Admit
   normal requests only after readiness, if implementing automatic rollback.
   Record before/after commits and retain the previous release and its snapshot.
5. On failure before the DB changes, restore the previous active release and
   service state. After migrations, restore the pre-update DB automatically
   only if you can prove that no user writes were let through and you can
   restore with the process stopped and no stale WAL/SHM sidecars. If that
   guarantee is absent, fail closed: keep the traffic fence/service stopped
   and give exact operator recovery instructions, rather than overwriting
   potentially newer health records. Never report success before health
   checks pass or silently roll back a live database. Retain diagnostics
   without diary data; set a nonzero exit status on failed updates.
6. Do not run a distro upgrade, change firewall rules, or auto-update the app
   in the background. The requested updater is manually invoked; package
   prerequisites, app updates and Debian/Proxmox upgrades have separate
   documented lifecycles.

TESTS, DOCUMENTATION AND COMPLETION
- Run `bash -n` and ShellCheck on the shell entry points. Add fixture or mocked
  checks for argument parsing, dry-run/no mutation, CTID conflicts, empty
  guest initial bootstrap without Git, private repo pause/resume, failed Git
  fetch, no-change update, divergent ref, lock contention, failed build,
  backup/migration failure, and post-start health failure.
- With synthetic data, test a fresh supported Debian environment; verify apt
  actually puts Git and the real app dependencies in place before build.
  With two source revisions, verify that `update` actually builds a changed
  site, reports the new commit, and keeps account credentials, events and
  Arms/Legs/Speech selections across an update/restart. Show that a failed
  update preserves the prior release and that the backup can be restored.
  If you cannot test pct/pveam on actual Proxmox, state this explicitly and
  include a disposable-LXC validation checklist; do not treat mocks as proof
  of a working Proxmox deployment or attempt to use the user's live host.
- README: include clean-install examples, supported versions, GitHub private
  deploy-key steps, packages and paths, private HTTPS/WireGuard notes,
  bootstrapping the admin, status/update examples, backup/rollback instructions,
  and what to do after install/update fails. Explain when there is downtime
  and what a user sees if writing is temporarily disabled.
- Make the code changes in the repo workspace. Do not push, publish a PR,
  provision cloud hardware, or make live GitHub/Proxmox changes unless
  separately asked. Report changed files, exact verification commands and
  results, sample commands for the operator, and remaining real-host checks.
```
