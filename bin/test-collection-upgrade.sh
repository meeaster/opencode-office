#!/usr/bin/env bash
# Usage: bash bin/test-collection-upgrade.sh /absolute/shipped/office /absolute/candidate/office
set -eu
old=$1 new=$2
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
export HOME="$base/home" XDG_CONFIG_HOME="$base/config" XDG_DATA_HOME="$base/data" XDG_STATE_HOME="$base/state"
export XDG_CACHE_HOME="$base/cache" XDG_RUNTIME_DIR="$base/run"
export OFFICE_MACHINE_RECORD="$base/record" OFFICE_MISE_CONFIG_DIR="$base/mise" OFFICE_MACHINE_DIR="$base/machine"
export OFFICE_APP_CONFIG_DIR="$base/app" OFFICE_APP_PANELS_DIR="$base/panels" OFFICE_SYSTEMD_USER_DIR="$base/units"
export DOCKER_HOST="unix://$base/no-socket" DBUS_SESSION_BUS_ADDRESS="unix:path=$base/no-bus" GIT_ALLOW_PROTOCOL=file
unset OFFICE_CONTAINER
mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR"
cd "$base"
"$old" init "$base/work" >/dev/null
cd work
config() {
  cat >office.yaml <<EOF
name: exercise
state: $base/work-state
references: [{name: manual, url: owner}]
packages:
  - {name: aws-emulator, settings: {port: 9876${1:+, source_reference: $1}}}
EOF
}
syncpkg() { "$new" sync --packages >"$base/log" 2>&1 || { cat "$base/log"; return 1; }; }
list() { "$new" references list; }
enabled() {
  list >"$base/list"
  test "$(grep -c '^floci.*package aws-emulator$' "$base/list")" = 1
  grep '^manual.*office.yaml$' "$base/list"
}
config
"$old" sync --packages >/dev/null
"$old" references list | grep '^floci.*package aws-emulator$'
snapshot=.office/resolved/references.json
grep '"version": 3' "$snapshot"
enabled
v3owner=.office/packages/references/office.ts
cp "$v3owner" "$base/v3owner"
echo '// edited' >>"$v3owner"
if list >"$base/log" 2>&1; then exit 1; fi
grep 'package files edited' "$base/log"
cp "$base/v3owner" "$v3owner"
cp "$snapshot" "$base/v3"
sed -i 's/name: manual/name: floci/' office.yaml
if "$new" sync --packages >"$base/log" 2>&1; then exit 1; fi
grep 'floci claimed by both' "$base/log"
cmp "$base/v3" "$snapshot"
enabled
"$old" references list | grep '^manual.*office.yaml$'
config
syncpkg
grep '"version": 4' "$snapshot"
enabled
config true
syncpkg
enabled
test ! -e references/floci
mkdir -p references/floci
touch references/floci/keep
config false
syncpkg
list >"$base/list"
! grep -q '^floci' "$base/list" || exit 1
grep '^manual.*office.yaml$' "$base/list"
test -f references/floci/keep
config true
syncpkg
config '"false"'
if "$new" sync --packages >"$base/log" 2>&1; then exit 1; fi
grep 'package aws-emulator:.*source_reference: must be true or false' "$base/log"
list | grep '^floci.*package aws-emulator (stale)$'
config
syncpkg
# An unreadable replacement must keep last-good claims with the same source identity.
aws=.office/packages/aws-emulator
echo 'throw Error("broken copy")' >"$aws/office.ts"
mv "$aws/.settings.json" "$base/settings"
mkdir "$aws/.settings.json" # Simulate a restoration failure, rather than a repairable edit.
if "$new" sync --packages >"$base/log" 2>&1; then exit 1; fi
list | grep '^floci.*package aws-emulator (stale)$'
rmdir "$aws/.settings.json"
mv "$base/settings" "$aws/.settings.json"
syncpkg
cp "$snapshot" "$base/good"
sed -i 's/name: manual/name: floci/' office.yaml
if "$new" sync --packages >"$base/log" 2>&1; then exit 1; fi
grep 'floci claimed by both' "$base/log"
cmp "$base/good" "$snapshot"
config
mkdir -p packages/{catalog,author} "$base/git/pkg"
cat >packages/catalog/items.ts <<'EOF'
import type { Collection } from "../../.office/packages/office/package-context.ts";
type Item = { name: string; count: number };
export const items = {
  id: "catalog.items",
  parse(input: unknown): Item {
    if (!input || typeof input !== "object" || !("count" in input) || typeof input.count !== "number"
      || !("name" in input) || typeof input.name !== "string") throw Error("expected a counted item");
    return { name: input.name, count: input.count };
  },
} satisfies Collection<Item>;
EOF
cat >packages/catalog/office.ts <<'EOF'
import { items } from "./items.ts";
export default {name:"catalog",description:"Catalog",setup(ctx){
  ctx.collection(items);
  ctx.command({name:"catalog list",summary:"List items",run(inputs){
    for (const {value,owner,stale} of inputs.read(items)) console.log(value.name,value.count,owner,stale);
  }});
}};
EOF
cat >packages/author/office.ts <<'EOF'
import { items } from "../catalog/items.ts";
import { repositories } from "../../.office/packages/references/repositories.ts";
export default {name:"author",description:"Author",setup(ctx){
  ctx.add(items,{name:"pens",count:3});
  ctx.add(repositories,{name:"local-guide",url:"local"});
}};
EOF
cat >"$base/git/pkg/office.ts" <<'EOF'
export default {name:"writer",description:"Pinned",async setup(ctx){
  const {repositories}=await import("../references/repositories.ts");
  ctx.add(repositories,{name:"guide",url:"pinned"});
}};
EOF
git -C "$base/git" init -q
git -C "$base/git" add pkg
git -C "$base/git" -c user.name=test -c user.email=test@example.org commit -qm fixture
cat >>office.yaml <<EOF
  - name: author
  - name: catalog
  - {name: writer, repo: $base/git, path: pkg, ref: $(git -C "$base/git" rev-parse HEAD)}
EOF
syncpkg
list | grep '^guide.*package writer$'
list | grep '^local-guide.*package author$'
"$new" --help | grep 'catalog list'
"$new" catalog list | grep '^pens 3 package author false$'
sed -i 's/count:3/count:"bad"/' packages/author/office.ts
if "$new" sync --packages >"$base/log" 2>&1; then exit 1; fi
grep 'package author:.*expected a counted item' "$base/log"
echo 'throw Error("must not load author on dispatch")' >packages/author/office.ts
"$new" catalog list | grep '^pens 3 package author true$'
test ! -e node_modules && test ! -e .office/packages/writer/node_modules
