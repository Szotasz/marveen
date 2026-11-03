/**
 * Filler words that must not carry a RELAXED memory search on their own.
 *
 * The relaxed pass ORs the query's tokens together, each as a prefix match.
 * Measured on the live store, 2026-09-23: `zebra a hogy nem` returned ~50 rows.
 * "zebra" matched nothing; every row came from `a*`, `hogy*` and `nem*`, which
 * occur in nearly every Hungarian memory. The body looked like a recall.
 *
 * This list is applied ONLY to the relaxed pass. The strict (AND) pass keeps
 * every token, so `strict=1` and every query that AND already answers behave
 * exactly as before.
 *
 * Entries are stored accent-free and lowercase; isSearchStopword() folds the
 * token the same way, so `miért` and `miert` are one entry (the memories are
 * written both ways, and FTS5's unicode61 tokenizer folds diacritics too).
 * Deliberately limited to function words, pronouns, question words, auxiliaries
 * and postpositions: a content word that happens to be common is NOT filler,
 * and dropping it would turn a real question into a false "nothing found".
 */
const HU = `
a az egy es is de meg mar csak vagy mint ha mert hogy nem sem se ne
ez azt ezt azok ezek annak ennek arra erre abban ebben azon ezen ami amit amely
amelyik aki akit amikor ahol ahogy amig mig
van volt lesz lett nincs nincsen vannak voltak lesznek legyen
kell kellett lehet lehetne
ilyen olyan itt ott most akkor majd meg pedig tehat igy ugy
mi mit mik ki kit kik hol hova honnan mikor miert hogyan meddig mennyi mennyit melyik milyen mivel minek
igen talan persze
en te o mi ti ok engem teged ot nekem neked neki nekunk velem veled vele
el be fel le ra at ki
alatt felett utan elott kozott mellett nelkul miatt ellen szerint soran
minden valami valamit semmi senki nagyon
`

const EN = `
a an the and or but if of to in on at by for with from as into over about than then so
is are was were be been being am do does did done has have had
it its this that these those there here
what which who whom whose when where why how
not no yes
i you he she we they me my our your his her their them us
can could should would will shall may might must
any some all too very just also only
`

const STOPWORDS: ReadonlySet<string> = new Set(
  `${HU} ${EN}`.split(/\s+/).filter((w) => w.length > 0),
)

/** Lowercase and strip diacritics, the same folding FTS5 unicode61 applies. */
export function foldForStopwordCheck(token: string): string {
  return token.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

export function isSearchStopword(token: string): boolean {
  return STOPWORDS.has(foldForStopwordCheck(token))
}
