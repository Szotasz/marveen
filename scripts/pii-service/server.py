"""
PII anonymization service for the Marveen channel middleware.
Runs on localhost:5200. Endpoints:
  POST /anonymize   { "text": "..." }  -> { "anonymized": "...", "mapping": {...} }
  GET  /health      -> { "status": "ok" }

Entity types detected:
  SZEMELY_N   - person names (spaCy xx_ent_wiki_sm NER + HU name dict)
  EMAIL_N     - email addresses
  PHONE_N     - Hungarian phone numbers
  IBAN_N      - IBAN numbers (HU and international)
  TAJ_N       - TAJ-szam (Hungarian social security)
  ADOAZON_N   - Hungarian tax ID (adoazonositó jel)
  CIM_N       - Hungarian addresses (city + street pattern)
"""
import re
import threading
from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern, RecognizerResult
from presidio_analyzer.nlp_engine import SpacyNlpEngine, NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

app = Flask(__name__)

# Hungarian first names (KSH top 50 male + female, 2020 data)
HU_FIRST_NAMES = {
    "Bence", "Máté", "Dávid", "Ádám", "Péter", "Balázs", "Zoltán", "László",
    "István", "Gábor", "Tamás", "Attila", "Krisztián", "Norbert", "Márk",
    "Levente", "Dominik", "Kristóf", "Botond", "Ábrahám", "Mihály", "Ferenc",
    "János", "György", "Sándor", "Tibor", "Csaba", "Roland", "Viktor", "Andras",
    "Anna", "Zsófia", "Eszter", "Kata", "Petra", "Boglárka", "Réka", "Viktória",
    "Fanni", "Nóra", "Dorina", "Laura", "Lilla", "Veronika", "Zsuzsanna",
    "Erzsébet", "Katalin", "Mária", "Éva", "Judit", "Ágnes", "Monika",
    "Tünde", "Krisztina", "Szilvia", "Anita", "Erika", "Nikolett", "Orsolya",
}

# Common Hungarian surnames (KSH top 50, 2020)
HU_SURNAMES = {
    "Nagy", "Kovács", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár",
    "Németh", "Farkas", "Balogh", "Papp", "Takács", "Juhász", "Fekete",
    "Szőcs", "Lakatos", "Mészáros", "Oláh", "Simon", "Rácz", "Pintér",
    "Gál", "Fehér", "Szilágyi", "Bogdán", "Balog", "Kocsis", "Lukács",
    "Csordás", "Orbán", "Kelemen", "Fülöp", "Hegedűs", "Király", "Vincze",
    "Barna", "Fodor", "Somogyi", "Nemes", "Erdős", "Veres", "Halász",
    "Sándor", "Pál", "Sipos", "Gulyás", "Kósa", "Berki", "Szűcs",
}

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

    # TAJ-szam: 123-456-789 or 123456789
    analyzer.registry.add_recognizer(PatternRecognizer(
        supported_entity="TAJ",
        supported_language="xx",
        patterns=[Pattern("TAJ", r"\b\d{3}[-\s]\d{3}[-\s]\d{3}\b", 0.9)],
        context=["TAJ", "taj", "biztosítási", "biztositasi", "szám"],
    ))

    # Hungarian tax ID: 10 digits starting with 8
    analyzer.registry.add_recognizer(PatternRecognizer(
        supported_entity="ADOAZON",
        supported_language="xx",
        patterns=[Pattern("ADOAZON", r"\b8\d{9}\b", 0.7)],
        context=["adó", "adóazonosító", "adoazon", "adószám", "azonosító"],
    ))

    # Hungarian phone: +36 or 06 prefix
    analyzer.registry.add_recognizer(PatternRecognizer(
        supported_entity="PHONE_HU",
        supported_language="xx",
        patterns=[
            Pattern("PHONE_HU_INTL", r"\+36[\s\-]?[1-9]\d[\s\-]?\d{3}[\s\-]?\d{3,4}\b", 0.95),
            Pattern("PHONE_HU_LOCAL", r"\b06[\s\-]?[1-9]\d[\s\-]?\d{3}[\s\-]?\d{3,4}\b", 0.95),
        ],
    ))

    # IBAN (HU and international)
    analyzer.registry.add_recognizer(PatternRecognizer(
        supported_entity="IBAN_HU",
        supported_language="xx",
        patterns=[
            Pattern("IBAN_HU", r"\bHU\d{2}[\s]?(\d{4}[\s]?){6}\b", 0.98),
            Pattern("IBAN_INTL", r"\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?([A-Z0-9]{4}[\s]?){2,6}[A-Z0-9]{1,4}\b", 0.85),
        ],
    ))

    # Hungarian address: strict patterns only to avoid over-matching names
    analyzer.registry.add_recognizer(PatternRecognizer(
        supported_entity="ADDRESS_HU",
        supported_language="xx",
        patterns=[
            # Budapest kerület: "XIV. kerület" or "14. ker."
            Pattern("DISTRICT", r"\b(I{1,3}|IV|VI{0,3}|IX|X{0,3}I{0,3}|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII|\d{1,2})\.\s*(kerület|ker\.)\b", 0.8),
            # Strict street: "Kossuth Lajos utca 14" -- at most 3 words before the street type
            Pattern("STREET", r"\b[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ]?[a-záéíóöőúüű]+){0,2}\s+(utca|út|tér|köz|sor|dűlő|liget|fasor|körút|krt\.?)\s+\d{1,3}[a-z]?\b", 0.8),
        ],
    ))

    return analyzer


def get_analyzer() -> AnalyzerEngine:
    global _analyzer
    if _analyzer is None:
        with _lock:
            if _analyzer is None:
                _analyzer = _build_analyzer()
    return _analyzer


# Counter class for sequential marker assignment
class _Counter:
    def __init__(self):
        self._counts: dict[str, int] = {}

    def next(self, entity_type: str) -> int:
        self._counts[entity_type] = self._counts.get(entity_type, 0) + 1
        return self._counts[entity_type]


# Entity type -> marker prefix mapping
_ENTITY_TO_PREFIX = {
    "PERSON": "SZEMELY",
    "PER": "SZEMELY",
    "TAJ": "TAJ",
    "ADOAZON": "ADOAZON",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_NUMBER": "PHONE",
    "PHONE_HU": "PHONE",
    "IBAN_CODE": "IBAN",
    "IBAN_HU": "IBAN",
    "ADDRESS_HU": "CIM",
    "LOCATION": "CIM",
}


def anonymize_text(text: str) -> tuple[str, dict[str, str]]:
    """
    Anonymize PII in text. Returns (anonymized_text, mapping).
    mapping: {"SZEMELY_1": "Kovács János", ...}
    """
    if not text.strip():
        return text, {}

    analyzer = get_analyzer()
    results = analyzer.analyze(text=text, language="xx", entities=list(_ENTITY_TO_PREFIX.keys()))

    # Post-process: if a LOCATION span starts with a known HU surname, split it:
    # the leading "Surname Firstname" portion becomes a PERSON result.
    expanded: list[RecognizerResult] = []
    for r in results:
        if r.entity_type == "LOCATION":
            span = text[r.start:r.end]
            m = re.match(r'^([A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+)?)', span)
            if m:
                first_word = m.group(1).split()[0]
                if first_word in HU_SURNAMES:
                    name_end = r.start + m.end()
                    # Shrink the LOC to start after the name
                    loc_start = name_end
                    while loc_start < r.end and text[loc_start] == ' ':
                        loc_start += 1
                    expanded.append(RecognizerResult(
                        entity_type="PERSON",
                        start=r.start,
                        end=name_end,
                        score=0.75,
                    ))
                    if loc_start < r.end:
                        expanded.append(RecognizerResult(
                            entity_type="LOCATION",
                            start=loc_start,
                            end=r.end,
                            score=r.score,
                        ))
                    continue
        expanded.append(r)
    results = expanded

    # Also run HU name dict scan and merge (additive, overlaps handled in dedup)
    results = results + _hu_name_scan(text)

    mapping: dict[str, str] = {}
    counter = _Counter()

    # Sort longest-span-first to handle overlaps
    results = sorted(results, key=lambda r: -(r.end - r.start))
    seen_spans: list[tuple[int, int]] = []
    deduped: list[RecognizerResult] = []
    for r in results:
        overlaps = any(not (r.end <= s[0] or r.start >= s[1]) for s in seen_spans)
        if not overlaps:
            deduped.append(r)
            seen_spans.append((r.start, r.end))

    # Sort by start position descending for in-place replacement
    deduped.sort(key=lambda r: -r.start)

    result_text = text
    for r in deduped:
        original = text[r.start:r.end]
        prefix = _ENTITY_TO_PREFIX.get(r.entity_type, r.entity_type)
        n = counter.next(prefix)
        marker = f"{prefix}_{n}"
        mapping[marker] = original
        result_text = result_text[:r.start] + marker + result_text[r.end:]

    return result_text, mapping


def _hu_name_scan(text: str) -> list[RecognizerResult]:
    """Simple Hungarian name dict scan as fallback when NER finds nothing."""
    results = []
    # Look for Surname Firstname or Firstname Surname patterns
    words = re.findall(r'\b[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+\b', text)
    for word in set(words):
        if word in HU_SURNAMES or word in HU_FIRST_NAMES:
            for m in re.finditer(r'\b' + re.escape(word) + r'\b', text):
                results.append(RecognizerResult(
                    entity_type="PERSON",
                    start=m.start(),
                    end=m.end(),
                    score=0.6,
                ))
    return results


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
