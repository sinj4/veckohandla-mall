#!/bin/sh
# Fyll Willys-korgen på den här datorn med veckans plan från molnet.
# Willys-inloggningen (browser-profiles/) finns bara här och lämnar aldrig datorn.
#
# Valläget (meny.lage: val i config.yaml):
#   ./fyll.sh             fyll korgen om rätterna redan är valda (t.ex. från mobilen), annars visa förslagen
#   ./fyll.sh 2 4 5 8 9   handla de valda rätterna (första = måndag), fyll korgen och spara data/ i repot
# Auto-läget:
#   ./fyll.sh            senaste veckan
#   ./fyll.sh 2026-v43   en viss vecka
# Båda lägena:
#   ./fyll.sh --betyg                  sätt + eller − på förra veckans rätter och spara data/ i repot
#   ./fyll.sh --betyg --vecka 2026-v43
set -e
HEM="$(cd "$(dirname "$0")" && pwd)"
KOD="${VECKOHANDLA_KOD:-$HOME/veckohandla}"
PY="$KOD/.venv/bin/python"
git -C "$KOD" pull --ff-only
git -C "$HEM" pull --ff-only
cd "$KOD"
export VECKOHANDLA_DATA="$HEM/data" VECKOHANDLA_CONFIG="$HEM/config.yaml" VECKOHANDLA_FYLL_KOMMANDO="$0"

# Committa och pusha data/ till det här repot (om något ändrats)
spara_data() {
  git -C "$HEM" add data/
  if git -C "$HEM" diff --cached --quiet; then
    echo "Inget nytt i data/"
  else
    git -C "$HEM" commit -m "$1"
    git -C "$HEM" push
  fi
}

if [ "$1" = "--betyg" ]; then
  shift
  set +e
  "$PY" -m veckohandla betyg "$@"
  kod=$?
  set -e
  spara_data "Betyg $(date +%G-v%V)"
  exit "$kod"
fi

case "$1" in
  '' | *[!0-9]*) ;;  # inget nummer (t.ex. 2026-v43)
  *)
    # Spara data/ även om korgen eller mejlet misslyckas – planen och korgfilen är redan skrivna
    set +e
    "$PY" -m veckohandla valj "$@" --fyll-varukorg
    kod=$?
    set -e
    spara_data "Valda rätter $(date +%G-v%V): $*"
    exit "$kod"
    ;;
esac

LAGE="$("$PY" -c 'import sys, yaml; print(((yaml.safe_load(open(sys.argv[1])) or {}).get("meny") or {}).get("lage", "auto"))' "$VECKOHANDLA_CONFIG")"
if [ "$LAGE" = "val" ]; then
  if [ $# -eq 0 ]; then
    # Är veckans korgfil nyare än förslagen (valet gjort i GitHub-appen)? Jämför commit-tider –
    # filernas ändringstid säger bara när git checkade ut dem.
    senaste="$(ls "$HEM"/data/*-v[0-9][0-9]-forslag.json 2>/dev/null | sort | tail -1)"
    if [ -n "$senaste" ]; then
      vecka="$(basename "$senaste" -forslag.json)"
      korg_tid="$(git -C "$HEM" log -1 --format=%ct -- "data/$vecka-korg.json")"
      forslag_tid="$(git -C "$HEM" log -1 --format=%ct -- "data/$vecka-forslag.json")"
      if [ -n "$korg_tid" ] && [ -n "$forslag_tid" ] && [ "$korg_tid" -gt "$forslag_tid" ]; then
        echo "Rätterna för $vecka är redan valda – fyller korgen."
        exec "$PY" -m veckohandla fyll-varukorg "$vecka"
      fi
    fi
  fi
  exec "$PY" -m veckohandla forslag "$@"
fi
exec "$PY" -m veckohandla fyll-varukorg "$@"
