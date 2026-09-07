#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Package a skill folder into an Anthropic-compliant skill.zip.
#
# Spec (cross-client: Claude Code / Codex / OpenCode):
#   - zip's first layer MUST be a folder named exactly like SKILL.md's `name`.
#   - that folder MUST contain SKILL.md right inside it (no extra nesting).
#   - optional: scripts/ references/ assets/ agents/openai.yaml
#   - frontmatter `name` must match ^[a-z0-9]+(-[a-z0-9]+)*$, <=64 chars,
#     and equal the folder name.
#   - `description` should carry 功能 + 触发条件 + 关键词.
#   - only name/description/license/compatibility/metadata are cross-client;
#     other keys (e.g. allowed-tools/agent/model) are Claude Code extensions
#     that Codex/OpenCode ignore (non-fatal warning).
#
# Usage:
#   tools/package-skill.sh <skill-dir>            # package one skill
#   tools/package-skill.sh --check <skill-dir>    # validate only, no zip written
#   tools/package-skill.sh --all <parent-dir>     # package every dir w/ SKILL.md
#   tools/package-skill.sh -o <zip> <skill-dir>
#   tools/package-skill.sh --max-lines <n> <skill-dir>
# ---------------------------------------------------------------------------
set -euo pipefail

MAX_LINES=500
OUT=""
ALL_DIR=""
DIR=""
PROJECT_DIR=""
SKILL_NAME=""
REFERENCE_DIR=""
RUNTIME_PATHS=""
KEEP_BUILD=0
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Package a skill folder into an Anthropic-compliant skill.zip.

Usage:
  tools/package-skill.sh [options] <skill-dir>
  tools/package-skill.sh --check <skill-dir>
  tools/package-skill.sh --all <parent-dir> [options]
  tools/package-skill.sh --project <dir> [-o <zip>] [options]

Options:
  -o, --out <file>   Output zip path (default: <parent>/<name>.zip)
                     Not used in --all mode (each skill writes next to itself).
  --check            Validate only (frontmatter + SKILL.md), write no zip.
  --max-lines <n>    SKILL.md max line count (default 500)
  --all <dir>        Package every subdirectory that contains SKILL.md
  --project <dir>    Build a self-contained skill from a project repo: copies
                     the runtime (src/, browser/, package.json, ...) plus the
                     authored skill docs into a temp staging dir, then zips.
                     node_modules is never bundled. Requires a SKILL.md at
                     <dir>/skills/<name>/SKILL.md.
  --skill-name <n>   Skill folder/name (default: single bin key from package.json).
  --reference-dir <d>  Authored skill docs dir (default <dir>/skills/<name>).
  --runtime <globs>  Space-separated project-relative runtime paths to copy
                     (default: src browser package.json package-lock.json).
  --keep-build       Keep the temp staging dir (for inspection).
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out) OUT="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --max-lines) MAX_LINES="$2"; shift 2 ;;
    --all) ALL_DIR="$2"; shift 2 ;;
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --skill-name) SKILL_NAME="$2"; shift 2 ;;
    --reference-dir) REFERENCE_DIR="$2"; shift 2 ;;
    --runtime) RUNTIME_PATHS="$2"; shift 2 ;;
    --keep-build) KEEP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; DIR="${1:-}"; shift ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *) DIR="$1"; shift ;;
  esac
done

# Sanity: MAX_LINES must be a positive integer.
if ! [[ "$MAX_LINES" =~ ^[0-9]+$ ]] || (( MAX_LINES <= 0 )); then
  echo "error: --max-lines must be a positive integer" >&2; exit 2
fi

command -v node >/dev/null 2>&1 || { echo "error: node (>=18) required to parse frontmatter" >&2; exit 1; }
if [[ "$CHECK_ONLY" != "1" ]]; then
  command -v zip   >/dev/null 2>&1 || { echo "error: zip required" >&2; exit 1; }
  command -v unzip >/dev/null 2>&1 || { echo "error: unzip required" >&2; exit 1; }
fi

# Read frontmatter from SKILL.md.
# Emits three fields separated by \x1f: name, description, non-standard keys.
# Uses Node (repo requires Node >= 18).
read_meta() {
  local sk="$1"
  node - "$sk" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
if (!fs.existsSync(file)) process.exit(0);
const md = fs.readFileSync(file, "utf8");
const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(md);
const fm = m ? m[1] : "";
const lines = fm.split("\n");
function get(k) {
  const p = lines.find((l) => l.startsWith(k + ":"));
  if (!p) return "";
  return p.slice(k.length + 1).trim().replace(/^["']|["']$/g, "").trim();
}
const standard = new Set(["name", "description", "license", "compatibility", "metadata"]);
const ext = [];
for (const l of lines) {
  const mm = /^([A-Za-z0-9_-]+):/.exec(l);
  if (mm && !standard.has(mm[1])) ext.push(mm[1]);
}
process.stdout.write([get("name"), get("description"), ext.join(",")].join("\x1f"));
NODE
}

# Soft-check description carries 功能 + 触发条件 + 关键词 (warning only).
check_description() {
  local d="$1"
  local lower
  lower="$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]')"
  if (( ${#d} < 40 )); then
    echo "   w: description 过短(${#d}字符)，建议写清 功能+触发场景+关键词，否则影响自动触发" >&2
  fi
  if ! printf '%s\n' "$lower" | grep -qE 'use when|whenever|when |use for|use to|if you|when processing|for processing|处理|提取|生成|解析|扫描|需要|当|用于'; then
    echo "   w: description 未见明显触发条件/关键词（建议含 'Use when ...' 或类似触发语）" >&2
  fi
}

# Package (or, if CHECK_ONLY, just validate) a single skill dir.
package_one() {
  local dir="$1"
  local abs sk_md name desc meta names ext parent out args lines
  abs="$(cd "$dir" && pwd)"
  name="$(basename "$abs")"
  sk_md="$abs/SKILL.md"

  if [[ ! -f "$sk_md" ]]; then
    echo "!! SKIP (no SKILL.md): $abs" >&2
    return 1
  fi

  meta="$(read_meta "$sk_md")"
  IFS=$'\x1f' read -r names desc ext <<<"$meta" || true

  echo "==> $name"

  # --- frontmatter checks ---
  if [[ -z "$names" ]]; then
    echo "   !! SKIP: no frontmatter 'name' in SKILL.md" >&2
    return 1
  fi
  if [[ ! "$names" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "   !! SKIP: 'name' '$names' must match ^[a-z0-9]+(-[a-z0-9]+)*$" >&2
    return 1
  fi
  if (( ${#names} > 64 )); then
    echo "   !! SKIP: 'name' longer than 64 chars" >&2
    return 1
  fi
  if [[ "$names" != "$name" ]]; then
    echo "   !! SKIP: frontmatter name '$names' != folder name '$name'" >&2
    return 1
  fi
  if [[ -z "$desc" ]]; then
    echo "   !! SKIP: no frontmatter 'description' in SKILL.md" >&2
    return 1
  fi
  if (( ${#desc} > 1024 )); then
    echo "   !! SKIP: 'description' longer than 1024 chars" >&2
    return 1
  fi

  # --- description quality (warning) ---
  check_description "$desc"

  # --- non-cross-client frontmatter keys (warning) ---
  if [[ -n "$ext" ]]; then
    echo "   w: frontmatter 含非跨客户端字段: $ext（Claude Code 扩展，Codex/OpenCode 忽略但不报错）" >&2
  fi

  # --- SKILL.md length check ---
  lines="$(awk 'END{print NR}' "$sk_md" 2>/dev/null || echo 0)"
  if (( lines > MAX_LINES )); then
    echo "   !! SKIP: SKILL.md has $lines lines (>$MAX_LINES); move detail into references/" >&2
    return 1
  fi

  # --- forbidden content (still excluded from the zip) ---
  for p in node_modules .git .DS_Store; do
    if [[ -e "$abs/$p" ]]; then
      echo "   w: excluding '$p' from the zip" >&2
    fi
  done

  # --- in --check mode, stop here (no zip written) ---
  if [[ "$CHECK_ONLY" = "1" ]]; then
    echo "   OK (check only, no zip written)" >&2
    return 0
  fi

  # --- zip with folder as first layer ---
  parent="$(dirname "$abs")"
  if [[ -z "$OUT" ]]; then
    out="$parent/$name.zip"
  else
    out="$OUT"
    mkdir -p "$(dirname "$out")"
  fi
  args=( -r "$out" "$name/" )
  for p in node_modules .git .DS_Store; do
    args+=( -x "$name/$p/*" "$name/$p" )
  done
  ( cd "$parent" && zip "${args[@]}" >/dev/null )
  echo "   -> $out"

  # --- structure self-check ---
  local first_entry stray leaked
  first_entry="$(unzip -Z1 "$out" | sed -n '1p')"
  if [[ "$first_entry" != "$name/" ]]; then
    echo "   !! FAIL: first zip entry '$first_entry', expected '$name/'" >&2
    return 1
  fi
  # SKILL.md must sit immediately inside the skill folder.
  if ! unzip -Z1 "$out" | grep -qx "$name/SKILL.md"; then
    echo "   !! FAIL: '$name/SKILL.md' missing inside the zip" >&2
    return 1
  fi
  # No entry may live outside the skill folder (no stray files at zip root).
  stray="$(unzip -Z1 "$out" | grep -v "^$name/" | grep . | head -n1 || true)"
  if [[ -n "$stray" ]]; then
    echo "   !! FAIL: zip 内存在技能文件夹之外的条目: $stray" >&2
    return 1
  fi
  # No forbidden path may leak into the archive.
  leaked="$(unzip -Z1 "$out" | grep -E '(^|/)(node_modules|\.git)(/|$)|(^|/)\.DS_Store$' | head -n1 || true)"
  if [[ -n "$leaked" ]]; then
    echo "   !! FAIL: 打包结果包含应排除的路径: $leaked" >&2
    return 1
  fi

  echo "   OK ($(du -h "$out" | cut -f1))"
}

# Build a self-contained skill from a project repo (runtime + authored docs).
# --project <dir> assembles <staging>/<name>/ with the runnable runtime from the
# project (src/, browser/, package.json, ...) PLUS the authored skill docs from
# <reference-dir> (SKILL.md, references/, schemas), then calls package_one.
# node_modules is never bundled. Requires a SKILL.md at <dir>/skills/<name>/.
package_project() {
  local proj="$1"
  local stg="" sk_dir="" ref_dir="" out="" rc=0 rp ok=0 ritems
  proj="$(cd "$proj" && pwd)"
  [[ -f "$proj/package.json" ]] || { echo "error: no package.json in $proj" >&2; return 2; }

  # Derive skill name: single bin key, else package name; --skill-name overrides.
  if [[ -z "$SKILL_NAME" ]]; then
    SKILL_NAME="$(node - "$proj/package.json" <<'NODE'
const pkg = require(process.argv[2]);
const bins = Object.keys(pkg.bin || {});
process.stdout.write(bins.length === 1 ? bins[0] : (pkg.name || ""));
NODE
)"
  fi
  [[ -n "$SKILL_NAME" ]] || { echo "error: cannot determine --skill-name" >&2; return 2; }
  if [[ ! "$SKILL_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "error: --skill-name '$SKILL_NAME' must match ^[a-z0-9]+(-[a-z0-9]+)*$" >&2; return 2
  fi

  ref_dir="${REFERENCE_DIR:-$proj/skills/$SKILL_NAME}"
  [[ -f "$ref_dir/SKILL.md" ]] || {
    echo "error: no SKILL.md in reference dir '$ref_dir' (pass --reference-dir or --skill-name)" >&2
    return 2
  }

  if [[ "$CHECK_ONLY" = "1" ]]; then
    # Validate the authored skill (no runtime injected, no zip written).
    package_one "$ref_dir"
    return $?
  fi

  # Build a temp staging dir populated with authored docs + runnable runtime.
  stg="$(mktemp -d)"
  sk_dir="$stg/$SKILL_NAME"
  mkdir -p "$sk_dir"
  ( cd "$ref_dir" && cp -a . "$sk_dir/" )

  ritems="${RUNTIME_PATHS:-src browser package.json package-lock.json}"
  for rp in $ritems; do
    if [[ -e "$proj/$rp" ]]; then
      cp -a "$proj/$rp" "$sk_dir/"
      ok=1
    else
      echo "   w: runtime item '$rp' not found in project (skipped)" >&2
    fi
  done
  if [[ "$ok" = "0" ]]; then
    echo "   w: no runtime items copied; skill may not be self-contained" >&2
  fi

  if [[ -z "$OUT" ]]; then
    OUT="$proj/$SKILL_NAME.zip"
  else
    # package_one zips from within <parent>; make OUT absolute so a relative
    # -o path is written to the caller's cwd, not to the staging temp dir.
    mkdir -p "$(dirname "$OUT")"
    if [[ "$OUT" != /* ]]; then
      OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
    fi
  fi

  package_one "$sk_dir" || rc=1

  if [[ "$KEEP_BUILD" = "1" ]]; then
    echo "   build dir kept: $stg" >&2
  else
    rm -rf "$stg"
  fi
  return $rc
}

if [[ -n "$ALL_DIR" ]]; then
  [[ -d "$ALL_DIR" ]] || { echo "error: not a directory: $ALL_DIR" >&2; exit 2; }
  if [[ -n "$OUT" ]]; then
    echo "w: --out 与 --all 一起使用会被忽略（每个技能输出到各自上层目录）" >&2
    OUT=""
  fi
  echo "== Packaging all skills under $ALL_DIR =="
  mapfile -t SKILL_FILES < <(find "$ALL_DIR" -type f -name SKILL.md \
    -not -path '*/node_modules/*' -not -path '*/.git/*' | sort)
  if (( ${#SKILL_FILES[@]} == 0 )); then
    echo "error: 在 $ALL_DIR 下未找到任何 SKILL.md" >&2
    exit 2
  fi
  failed=0
  for sk in "${SKILL_FILES[@]}"; do
    package_one "$(dirname "$sk")" || failed=1
  done
  [[ "$failed" -ne 0 ]] && exit 1
  exit 0
fi

if [[ -n "$PROJECT_DIR" ]]; then
  [[ -d "$PROJECT_DIR" ]] || { echo "error: not a directory: $PROJECT_DIR" >&2; exit 2; }
  package_project "$PROJECT_DIR"
  exit $?
fi

[[ -n "$DIR" ]] || { echo "error: missing <skill-dir> (or use --all)" >&2; usage; exit 2; }
[[ -d "$DIR" ]] || { echo "error: not a directory: $DIR" >&2; exit 2; }

package_one "$DIR"
