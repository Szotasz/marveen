"""
PII anonymization service for the Marveen channel middleware.
Runs on localhost:5200. Endpoints:
  POST /anonymize   { "text": "..." }  -> { "anonymized": "...", "mapping": {...} }
  GET  /health      -> { "status": "ok" }

Entity types detected:
  SZEMELY_N   - person names (HU name dictionary + suffix-aware stems)
  EMAIL_N     - email addresses, incl. obfuscated "(kukac)" forms
  PHONE_N     - Hungarian phone numbers (+36 / 36 / 06 / (1) forms)
  IBAN_N      - IBAN numbers (HU and international)
  SZAMLA_N    - domestic bank account numbers (8-8[-8])
  TAJ_N       - TAJ-szam (Hungarian social security)
  ADOAZON_N   - Hungarian personal tax ID (adoazonositó jel)
  ADOSZAM_N   - company tax number (12345678-1-42)
  SZIG_N      - identity card number
  RENDSZAM_N  - licence plate
  IP_N        - IP address
  SZULDATUM_N - birth date (only next to a birth context word)
  CIM_N       - Hungarian addresses (postal code / street pattern)
"""
import re
import threading
from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern, RecognizerResult
from presidio_analyzer.nlp_engine import SpacyNlpEngine, NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

app = Flask(__name__)

# Hungarian first names (KSH frequent male + female names)
HU_FIRST_NAMES = {
    "Bence", "Máté", "Dávid", "Ádám", "Péter", "Balázs", "Zoltán", "László",
    "István", "Gábor", "Tamás", "Attila", "Krisztián", "Norbert", "Márk",
    "Levente", "Dominik", "Kristóf", "Botond", "Ábrahám", "Mihály", "Ferenc",
    "János", "György", "Sándor", "Tibor", "Csaba", "Roland", "Viktor", "András",
    "József", "Lajos", "Imre", "Béla", "Károly", "Róbert", "Richárd", "Gergő",
    "Gergely", "Ákos", "Barnabás", "Bálint", "Dániel", "Milán", "Olivér",
    "Zsolt", "Gyula", "Miklós", "Antal", "Árpád", "Szabolcs", "Endre", "Ernő",
    "Kálmán", "Géza", "Dezső", "Jenő", "Vilmos", "Henrik", "Ottó", "Martin",
    "Anna", "Zsófia", "Eszter", "Kata", "Petra", "Boglárka", "Réka", "Viktória",
    "Fanni", "Nóra", "Dorina", "Laura", "Lilla", "Veronika", "Zsuzsanna",
    "Erzsébet", "Katalin", "Mária", "Éva", "Judit", "Ágnes", "Monika",
    "Tünde", "Krisztina", "Szilvia", "Anita", "Erika", "Nikolett", "Orsolya",
    "Ilona", "Margit", "Magdolna", "Irén", "Piroska", "Klára", "Ildikó",
    "Edit", "Andrea", "Gabriella", "Melinda", "Beáta", "Csilla", "Tímea",
    "Rita", "Hajnalka", "Enikő", "Adrienn", "Brigitta", "Kitti", "Bianka",
    "Vivien", "Dóra", "Luca", "Hanna", "Emma", "Lili", "Zoé", "Dalma",
}

# Common Hungarian surnames (KSH frequent surnames)
HU_SURNAMES = {
    "Nagy", "Kovács", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár",
    "Németh", "Farkas", "Balogh", "Papp", "Takács", "Juhász", "Fekete",
    "Szőcs", "Lakatos", "Mészáros", "Oláh", "Simon", "Rácz", "Pintér",
    "Gál", "Fehér", "Szilágyi", "Bogdán", "Balog", "Kocsis", "Lukács",
    "Csordás", "Orbán", "Kelemen", "Fülöp", "Hegedűs", "Király", "Vincze",
    "Barna", "Fodor", "Somogyi", "Nemes", "Erdős", "Veres", "Halász",
    "Sándor", "Pál", "Sipos", "Gulyás", "Kósa", "Berki", "Szűcs",
    "Bíró", "Vass", "Szalai", "Pásztor", "Hajdu", "Kozma", "Bakos", "Jakab",
    "Boros", "Katona", "Szekeres", "Bodnár", "Fazekas", "Soós", "Dudás",
    "Borbély", "Bognár", "Deák", "Vörös", "Benkő", "Illés", "Kun",
}

# Surnames that are also everyday words ("Nagy öröm", "Kiss hiba"): a lone
# capitalised one at the start of a sentence is not taken as a name.
_AMBIGUOUS_SURNAMES = {
    "Nagy", "Kiss", "Fekete", "Fehér", "Barna", "Király", "Nemes", "Veres",
    "Vörös", "Erdős", "Simon", "Sándor", "Pál", "Boros", "Katona", "Kun",
}

_UP = "A-ZÁÉÍÓÖŐÚÜŰ"
_LO = "a-záéíóöőúüű"
_CAP_WORD = re.compile(rf"[{_UP}][{_LO}]+")
# Married-name and case suffixes glued to a name: Andrásné, Bencének, Esztert.
# An explicit list, not "any lowercase tail": that would read Katalógus as
# Kata+lógus and Nagyon as Nagy+on.
_CASE_SUFFIXES = (
    "t|ot|et|öt|at|nak|nek|val|vel|nál|nél|ról|ről|ra|re|ba|be|ban|ben|ból|ből"
    "|hoz|hez|höz|tól|től|ig|ért|é|ék|on|en|ön|n|ként|kor"
)
_NAME_SUFFIX = re.compile(rf"(?:né(?:{_CASE_SUFFIXES})?|{_CASE_SUFFIXES})")

# Cache for the analyzer engine (lazy init)
_analyzer: AnalyzerEngine | None = None
_anonymizer = AnonymizerEngine()
_lock = threading.Lock()


def _build_analyzer() -> AnalyzerEngine:
    nlp_config = {
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "xx", "model_name": "xx_ent_wiki_sm"}],
    }
    provider = NlpEngineProvider(nlp_configuration=nlp_config)
    nlp_engine = provider.create_engine()

    analyzer = AnalyzerEngine(
        nlp_engine=nlp_engine,
        supported_languages=["hu", "en", "xx"],
    )

    def add(entity: str, patterns: list[tuple[str, str, float]], context=None):
        analyzer.registry.add_recognizer(PatternRecognizer(
            supported_entity=entity,
            supported_language="xx",
            patterns=[Pattern(n, rx, sc) for n, rx, sc in patterns],
            context=context,
            # Presidio defaults to IGNORECASE, which turned "1934 CI" into a
            # postal address and would let [A-Z] plates match any word.
            global_regex_flags=re.MULTILINE | re.DOTALL,
        ))

    # TAJ-szam: 123-456-789 or 123 456 789
    add("TAJ", [("TAJ", r"\b\d{3}[-\s]\d{3}[-\s]\d{3}\b", 0.9)],
        ["TAJ", "taj", "biztosítási", "biztositasi", "szám"])

    # Hungarian personal tax ID: 10 digits starting with 8
    add("ADOAZON", [("ADOAZON", r"\b8\d{9}\b", 0.7)],
        ["adó", "adóazonosító", "adoazon", "adószám", "azonosító"])

    # Company tax number: 12345678-1-42
    add("ADOSZAM", [("ADOSZAM", r"\b\d{8}-\d-\d{2}\b", 0.95)])

    # Domestic bank account (BBAN): 2x8 or 3x8 digit groups
    add("SZAMLA", [("SZAMLA", r"\b\d{8}-\d{8}(?:-\d{8})?\b", 0.95)])

    # Hungarian phone numbers. Always anchored on a 36/06 prefix or a
    # parenthesised area code, so bare 9-digit runs (TAJ, IDs) never match.
    _tail = r"[\s\-/]*\d{3}[\s\-]?\d{3,4}(?!\d)"
    _area = r"\(?(?:1|[2-9]\d)\)?"
    add("PHONE_HU", [
        ("PHONE_HU_INTL", r"(?<![\w+])(?:\+|00)?36[\s\-/]*" + _area + _tail, 0.95),
        ("PHONE_HU_LOCAL", r"(?<!\w)06[\s\-/]*" + _area + _tail, 0.95),
        ("PHONE_HU_PAREN", r"(?<!\w)\((?:1|[2-9]\d)\)" + _tail, 0.9),
    ])

    # IBAN (HU and international)
    add("IBAN_HU", [
        ("IBAN_HU", r"\bHU\d{2}[\s]?(\d{4}[\s]?){6}\b", 0.98),
        ("IBAN_INTL", r"\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?([A-Z0-9]{4}[\s]?){2,6}[A-Z0-9]{1,4}\b", 0.85),
    ])

    # Identity card number: 123456AB
    add("SZIG", [("SZIG", r"\b\d{6}[A-Z]{2}\b", 0.85)])

    # Licence plate: ABC-123 (old) and AA BB-123 (2022+)
    add("RENDSZAM", [
        ("RENDSZAM_OLD", r"\b[A-Z]{3}-\d{3}\b", 0.85),
        ("RENDSZAM_NEW", r"\b[A-Z]{2}\s?[A-Z]{2}-\d{3}\b", 0.85),
    ])

    # Hungarian address: optional "1234 City," prefix, street + house number,
    # optional /B, floor and door. Strict street-type anchor so plain
    # capitalised words never become addresses.
    _street = (
        rf"[{_UP}][{_LO}]+(?:\s+[{_UP}]?[{_LO}]+){{0,2}}\s+"
        r"(?:utca|út|útja|tér|köz|sor|dűlő|liget|fasor|körút|krt\.?|sétány|lakótelep)"
        r"\s+\d{1,4}(?:/[A-Za-z0-9]+)?\.?"
        r"(?:\s*\d{1,2}\.\s*(?:emelet|em\.)(?:\s*\d{1,3}\.?)?)?"
        r"(?:\s*(?:ajtó|szám))?"
    )
    add("ADDRESS_HU", [
        ("DISTRICT", r"\b(I{1,3}|IV|VI{0,3}|IX|X{0,3}I{0,3}|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII|\d{1,2})\.\s*(kerület|ker\.)\b", 0.8),
        ("POSTAL_STREET", rf"\b\d{{4}}\s+[{_UP}][{_LO}]+,?\s+" + _street, 0.9),
        # "6720 Szeged" -- but not an amount ("4500 Ft", "1200 Forint")
        ("POSTAL_CITY", rf"\b[1-9]\d{{3}}\s+(?!(?:Forint|Euró|Euro|Dollár|Darab|Liter|Hektár|Tonna|Óra|Perc)\b)[{_UP}][{_LO}]{{2,}}\b", 0.7),
        ("STREET", r"\b" + _street, 0.8),
    ])

    return analyzer


def get_analyzer() -> AnalyzerEngine:
    global _analyzer
    if _analyzer is None:
        with _lock:
            if _analyzer is None:
                _analyzer = _build_analyzer()
    return _analyzer


# Entity type -> marker prefix mapping
_ENTITY_TO_PREFIX = {
    "PERSON": "SZEMELY",
    "TAJ": "TAJ",
    "ADOAZON": "ADOAZON",
    "ADOSZAM": "ADOSZAM",
    "SZAMLA": "SZAMLA",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_HU": "PHONE",
    "IBAN_CODE": "IBAN",
    "IBAN_HU": "IBAN",
    "SZIG": "SZIG",
    "RENDSZAM": "RENDSZAM",
    "IP_ADDRESS": "IP",
    "ADDRESS_HU": "CIM",
    "SZULDATUM": "SZULDATUM",
}

# The multilingual spaCy NER (PERSON / LOCATION) is NOT used: on Hungarian
# text it tagged ordinary words ("Azt", "Csináld", "Mergelhető", "adatok")
# as people and places. Names come from the dictionary scan below, places
# only from the strict address patterns.
_ANALYZER_ENTITIES = [e for e in _ENTITY_TO_PREFIX if e not in ("PERSON", "SZULDATUM")]

# Obfuscated e-mail: name(kukac)example.hu, name [at] example.hu
_OBFUSCATED_EMAIL = re.compile(
    r"[\w.+-]+\s*(?:\(kukac\)|\[kukac\]|\(at\)|\[at\]|\skukac\s)\s*[\w-]+(?:\.[\w-]+)+",
    re.IGNORECASE,
)

# Birth date, only next to a birth context word (a bare date is not PII)
_BIRTH_DATE = re.compile(
    rf"(?:szület\w*|szül\.)\s*:?\s*(?:[{_UP}][{_LO}]+,\s*)?"
    rf"(\d{{4}}\.\s*(?:\d{{1,2}}\.|[{_LO}]+)\s*\d{{1,2}}\.?)",
    re.IGNORECASE,
)


def _regex_results(rx: re.Pattern, text: str, entity: str, score: float, group: int = 0) -> list[RecognizerResult]:
    return [
        RecognizerResult(entity_type=entity, start=m.start(group), end=m.end(group), score=score)
        for m in rx.finditer(text)
    ]


def _name_stem(word: str) -> tuple[str, str] | None:
    """('surname'|'first', stem) if word is a dictionary name, possibly with a
    glued married-name or case suffix (Andrásné, Bencének, Esztert)."""
    if word in HU_SURNAMES:
        return ("surname", word)
    if word in HU_FIRST_NAMES:
        return ("first", word)
    for i in range(len(word) - 1, 2, -1):
        stem, rest = word[:i], word[i:]
        if _NAME_SUFFIX.fullmatch(rest):
            # Hungarian lengthens a final a/e before a suffix: Bence -> Bencé-nek
            for cand in (stem, stem[:-1] + {"é": "e", "á": "a"}.get(stem[-1], stem[-1])):
                if cand in HU_FIRST_NAMES:
                    return ("first", cand)
                if cand in HU_SURNAMES and cand not in _AMBIGUOUS_SURNAMES:
                    return ("surname", cand)
    return None


def _is_sentence_start(text: str, pos: int) -> bool:
    i = pos - 1
    while i >= 0 and text[i] in " \t":
        i -= 1
    return i < 0 or text[i] in ".!?\n:("


def _hu_name_scan(text: str) -> list[RecognizerResult]:
    """Dictionary-driven name detection. A name is a run of capitalised words
    containing at least one dictionary name; a surname pulls in the
    capitalised word after it (Tóth Ilona), across a single line break."""
    words = list(_CAP_WORD.finditer(text))
    results = []
    i = 0
    while i < len(words):
        w = words[i]
        kind = _name_stem(w.group(0))
        if not kind:
            i += 1
            continue
        start, end = w.start(), w.end()
        j = i
        # Extend right: next capitalised word separated only by spaces or one newline
        while j + 1 < len(words):
            gap = text[words[j].end():words[j + 1].start()]
            if not re.fullmatch(r"[ \t]+|[ \t]*\n[ \t]*", gap):
                break
            nxt = words[j + 1]
            if _name_stem(nxt.group(0)) or (j == i and kind[0] == "surname"):
                end = nxt.end()
                j += 1
            else:
                break
        single = j == i
        if single and kind[0] == "surname" and w.group(0) in _AMBIGUOUS_SURNAMES \
                and _is_sentence_start(text, start):
            i += 1
            continue
        results.append(RecognizerResult(entity_type="PERSON", start=start, end=end, score=0.8))
        i = j + 1
    return results


def anonymize_text(text: str) -> tuple[str, dict[str, str]]:
    """
    Anonymize PII in text. Returns (anonymized_text, mapping).
    mapping: {"SZEMELY_1": "Kovács János", ...}
    """
    if not text.strip():
        return text, {}

    analyzer = get_analyzer()
    results = analyzer.analyze(text=text, language="xx", entities=_ANALYZER_ENTITIES)
    results += _hu_name_scan(text)
    results += _regex_results(_OBFUSCATED_EMAIL, text, "EMAIL_ADDRESS", 0.9)
    results += _regex_results(_BIRTH_DATE, text, "SZULDATUM", 0.9, group=1)

    # Overlaps: the more specific (higher score) span wins, then the longer
    # one -- so a company tax number is never re-labelled as a phone.
    results = sorted(results, key=lambda r: (-r.score, -(r.end - r.start)))
    deduped: list[RecognizerResult] = []
    for r in results:
        if all(r.end <= d.start or r.start >= d.end for d in deduped):
            deduped.append(r)

    # Number markers in reading order; an original that repeats keeps one marker.
    deduped.sort(key=lambda r: r.start)
    counts: dict[str, int] = {}
    by_original: dict[str, str] = {}
    mapping: dict[str, str] = {}
    spans: list[tuple[int, int, str]] = []
    for r in deduped:
        original = text[r.start:r.end]
        marker = by_original.get(original)
        if marker is None:
            prefix = _ENTITY_TO_PREFIX.get(r.entity_type, r.entity_type)
            counts[prefix] = counts.get(prefix, 0) + 1
            marker = f"{prefix}_{counts[prefix]}"
            by_original[original] = marker
            mapping[marker] = original
        spans.append((r.start, r.end, marker))

    result_text = text
    for start, end, marker in reversed(spans):
        result_text = result_text[:start] + marker + result_text[end:]

    return result_text, mapping


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/anonymize", methods=["POST"])
def anonymize():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "")
    if not isinstance(text, str):
        return jsonify({"error": "text must be a string"}), 400

    try:
        anonymized, mapping = anonymize_text(text)
        return jsonify({"anonymized": anonymized, "mapping": mapping})
    except Exception as e:
        app.logger.error("anonymize error: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/deanonymize", methods=["POST"])
def deanonymize():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "")
    mapping = data.get("mapping", {})
    if not isinstance(text, str) or not isinstance(mapping, dict):
        return jsonify({"error": "invalid input"}), 400

    result = text
    # Sort by marker length desc to avoid SZEMELY_1 matching inside SZEMELY_10
    for marker, original in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
        result = result.replace(marker, original)

    return jsonify({"text": result})


if __name__ == "__main__":
    # Warm up the analyzer on startup
    print("Loading NLP model...", flush=True)
    get_analyzer()
    print("PII service ready on :5200", flush=True)
    app.run(host="127.0.0.1", port=5200, debug=False)
