# Installing `office` and setting up an office

This runbook is for an AI agent installing `office` for a person, and readable by that person. It gets you from nothing to a running office that is committed and checked. Read all of it before you run anything. For background, see [README.md](README.md). This file is the procedure.

An **office** is a git repository of **desks**, which are folders for different kinds of work. OpenCode serves the desks, and Executor holds service accounts and schedules. Both run in Docker on this machine.

## 1. Ask first, in one message

Ask the user every question below, together, before you run any command other than the read-only checks in step 2. Offer the default where there is one, and wait for answers. The answers are the user's decisions. If an answer is missing or unclear, ask again. Never fill one in yourself.

1. **Office name**: lowercase letters, digits and dashes, such as `home` or `acme`. It names the containers and the state folder.
2. **Folder**: where the office repository goes. It must not exist yet, or must be empty. Default: `~/office`.
3. **Container or host mode**: in container mode (the default), the office runs its own OpenCode in a Docker container, so agents work inside it and can't touch the rest of this machine. In host mode, the office uses an OpenCode server that already runs on this machine, so agents work directly on it. Recommend container mode unless the user already runs an OpenCode server here and wants that.
4. **Desks**: one per area of work, each with a name in the same form as the office name and one line on what it is for, such as `research`: "reading and research notes". The template's `example` desk is replaced by these desks.
5. **Executor owner email**: a real address in the form `user@domain.tld`. It becomes the login of the office's Executor account. `office setup` generates the password and stores it encrypted. You never see it.
6. **Commit identity**: the name and email the office commits as. Offer the output of `git config --global user.name` and `git config --global user.email` if they are set.
7. **May `office` install its tools on this machine?** That means mise, SOPS, age, gh and pre-commit, installed into the user's home folder (`~/.local/share/office/host-tools` and mise's own folder), with no sudo and no shell profile changes. It also covers creating an age key at `~/.config/sops/age/keys.txt` (or reusing the one already there), which encrypts the office's secrets. If the user says no, they must install SOPS and age themselves. In host mode, also ask whether the office may link its tools into mise's global configuration (`--manage-machine`).
8. **Private GitHub repositories**: will the office clone private repositories, or push to GitHub? If yes, the user logs in to GitHub themselves later (see step 4).

## 2. Boundaries

**Never, whatever the user says:**
- Display, copy, log or store the Executor owner's password or any other credential. Don't run `office executor credentials`. That is for the user, in their own terminal.
- Run `sudo`, or install system packages.
- Run `gh auth login`, `claude auth login`, `/connect` or any other provider or account login for the user.

**Only with the user's yes:**
- Edit a shell startup file (`~/.bashrc`, `~/.zshrc`, `~/.profile`). Prefer to tell the user the line to add.
- Change global git configuration (`git config --global`).
- Choose any value from step 1 for them, including example or placeholder emails.

**Stop and report instead of working around it.** When an `office` command fails, or says something you think is wrong, show the user its exact output and stop. Don't patch around it by hand. That means no `docker rm`, no `docker` commands against the office's containers, no edits under `~/.local/share/office/`, `~/.cache/office/` or `.office/`, no installing Python or other tools yourself, and no reading office's source to find a workaround. The known problems listed in step 5 are the only exceptions, and that step says what to do for each.

Read-only checks are always fine: `docker info`, `git --version`, `command -v`, `ls`, `cat` on the office's files.

## 3. Install

Check the prerequisites. If one is missing, the user installs it, because it needs sudo:

```sh
docker info >/dev/null && docker compose version && docker buildx version && git --version
command -v python3   # needed for the gitleaks commit hook (pre-commit); see step 5 if missing
uname -sm            # releases are Linux x86_64 only
```

Install `office` (to `~/.local/bin/office`, verified against the release's checksums). It installs the newest release, whatever its age (`office update` applies a minimum age to later updates), and prints which:

```sh
curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | sh
```

If the script says `~/.local/bin` isn't on PATH, call `~/.local/bin/office` by its full path for the rest of this runbook. Then pass the PATH line the script printed on to the user, so they can add it themselves.

## 4. Create and set up the office

Use the user's answers wherever `<...>` appears.

```sh
office init <folder> --name <name>
cd <folder>
```

**Edit `office.yaml` before setup:**
- Under `desks:`, replace the `example:` entry with one entry per desk, keeping the same shape:
  ```yaml
  desks:
    research:
      description: Reading and research notes.
      repos: []
      skills: []
      app: true
  ```
- Delete the example desk's folder, which `init` created: `rm -rf example`. Doing this before setup means the example desk is never deployed.
- Add the commit identity, and `credentials: gh` if the user uses private GitHub repositories:
  ```yaml
  git:
    name: <commit name>
    email: <commit email>
    # credentials: gh
  ```
- Host mode only: set `opencode:` as the comment above it in `office.yaml` shows, and follow README.md's "Host mode". The step that copies the OpenCode server's password into the state folder handles a credential, so the user runs it.

**Run setup once, unattended**, from the office folder:

```sh
office setup --install-deps --generate-age-key --owner-email <owner email>
```

- Add `--manage-machine` in host mode if the user agreed to it.
- If the user refused tool installs (question 7), leave out `--install-deps`. If they refused an age key, leave out `--generate-age-key`. Setup then stops and names what's missing. Pass that on to the user.
- Setup takes several minutes the first time, because it builds an image and starts services. It needs no other input. It never displays the owner password when it isn't run in a terminal.
- With `credentials: gh`, setup stops and prints a `gh auth login ...` command. Give that exact command to the user, wait until they say they've logged in, then run the same `office setup` command again. Setup picks up where it stopped.
- If setup stops for any other reason, follow step 2: show the output, and rerun only after the user has fixed what it names.

## 5. Known problems in current releases

These are being fixed. Until they are, handle them exactly like this:

- **No commit hook, or `Warning: mise didn't install pre-commit ...; check network access`**: check whether `.git/hooks/pre-commit` exists in the office after setup. If it doesn't, report that as the fact: commits aren't checked by gitleaks. If `command -v python3` also found nothing, add that a missing Python 3 is the likely cause (the warning's mention of the network is misleading). Don't install Python yourself. Rerunning `office setup` once the user has installed `python3` installs the hook.
- **`a fresh Executor needs --owner-email <email>` even though you passed one**: the address was rejected as invalid. Ask the user for an address of the form `user@domain.tld`.
- **`office check` says `FAIL running versions: ... run office up`, and it's still there after one `office up`**: stop and report it. Never remove the container.
- **`office check` run inside the office's container crashes with `Executable not found in $PATH: "docker"`**: run `office check` on the host only.
- **`Existing .sops.yaml preserved. An authorized host must enroll this public recipient...`** on a rerun of setup in a new office: if `.sops.yaml` lists only the recipient that setup printed on this machine, you can ignore it.

## 6. Confirm, commit, hand off

```sh
office check          # every line ok or warn; exit status 0
git status --short
```

Setup never commits. Commit everything it wrote, which includes `office.yaml`, `office.lock`, `.sops.yaml`, `secrets/*.enc.json` and the desks. All of it is safe to commit: the secrets are encrypted, and the private age key lives outside the repository. `.office/` is the tool's and stays out of Git, except `.office/seeds/`, the seed store, which is committed with `office.lock`: sync keeps the rest out through the repository's `info/exclude`, so `git add -A` leaves it alone.

```sh
git add -A && git commit -m "Set up the office"
```

`office.yaml`'s `git:` identity applies inside the container only. If `git commit` fails with `unable to auto-detect email address` (common on a fresh machine), ask the user whether to set the identity for this repository only. Then use the identity they gave:

```sh
git config user.name "<commit name>" && git config user.email "<commit email>"
```

If they'd rather set it globally, they can run `git config --global ...` themselves.

**Finish by telling the user:**
- Where the office is, its desks, and that `office check` passed.
- **Back up the age key** `~/.config/sops/age/keys.txt` somewhere safe and private. Without it, the office's encrypted secrets can't be recovered. Never commit it.
- **Connect the app:** run `office pair` in the office folder, which prints a one-time link for the OpenCode app or a browser. The link grants access, so the user runs it.
- **Model sign-in is theirs.** A new office can already use OpenCode's free hosted models with no login. Prompts then go to OpenCode's service. For another provider, they use `/connect` in OpenCode. For Claude Code in container mode, they run `docker exec -it office-<name>-opencode-1 claude auth login`, then connect Claude Agent in OpenCode.
- The Executor dashboard is at `http://localhost:41440`. They get its login by running `office executor credentials` themselves.
- Anything you stopped on or skipped, with its exact output.
