# Literal archive-membership test for shell scripts (card a8a92d55).
#
# Why this exists: scripts/backup.sh verified its archive with
# `grep -qE "^${want}(/|$)" <tar -t listing>`, i.e. it used every manifest path
# as a REGULAR EXPRESSION. A Next.js route directory such as `[id]` is a
# character class there (one `i` or one `d`), so on 2026-09-24 12:14Z fourteen
# files that WERE in the archive were reported "MISSING", and a complete backup
# was marked "do NOT treat it as a good copy". Any other ERE metacharacter in a
# path -- ( ) + ? { } | ^ $ -- breaks the same way. A manifest path is a file
# name, not a pattern, so the comparison has to be literal.
#
# Usage:
#   . "${REPO_ROOT}/scripts/lib/archive-list-has.sh"
#   archive_list_has <listing-file> <path>
# Succeeds when <listing-file> (one member per line, `tar -t` output) holds
# <path> itself or anything under "<path>/" -- a directory named once in the
# manifest expands to many members -- and fails otherwise. "store/x" is never
# satisfied by "store/xyz". The path travels through the environment, not
# `awk -v`, because -v would rewrite backslash escapes in it. Plain POSIX awk,
# so it behaves the same under mawk, gawk and the BSD awk of macOS.

archive_list_has() {
  W="$2" awk 'BEGIN { w = ENVIRON["W"]; n = length(w) }
    n > 0 && substr($0, 1, n) == w && (length($0) == n || substr($0, n + 1, 1) == "/") { found = 1; exit }
    END { exit !found }' "$1"
}
