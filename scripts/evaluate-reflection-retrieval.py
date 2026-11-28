"""Compare retrieval on fictional journals offline, or explicitly check live Groq routing."""
import argparse
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from hashlib import file_digest, sha256
from importlib.metadata import version
from math import ceil
import json
import os
from pathlib import Path
import platform
from statistics import mean
import sys
from time import perf_counter
from uuid import NAMESPACE_URL, uuid4, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'backend'))

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import make_engine
from app.models import JournalEntry, User
from app.schemas.journal_qa import MAX_QA_SOURCES
from app.services.journal_retrieval import DATE_PATTERN, DATE_RANGE_PATTERN, retrieve_reflection_journals

FIXTURES = Path(__file__).with_name('reflection-retrieval-cases.json')
MODEL_REVISION = '614241f622f53c4eeff9890bdc4f31cfecc418b3'
ARTIFACT_SHA256 = {
    'model.onnx': 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
    'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
}
THRESHOLDS = (.72, .76, .80, .84, .88, .92, 1.01)


@dataclass(frozen=True)
class Case:
    name: str
    language: str
    split: str
    owner: str
    scenario: str
    query: str
    relevant: frozenset[str]
    prior: str | None = None
    date_window: list[str] | None = None

    def contextual_query(self):
        # Fixture annotation controls this comparison. It is not a proposed
        # production follow-up detector, and prior dates cannot widen a query.
        if self.scenario == 'follow_up' and self.prior:
            return f'{self.query}\n{DATE_PATTERN.sub(" ", self.prior)}'
        return self.query


@dataclass(frozen=True)
class Entry:
    name: str
    owner: str
    day: date
    content: str

    @property
    def id(self):
        return fixture_uuid(self.name)


def fixture_uuid(name):
    return uuid5(NAMESPACE_URL, f'https://aurajournal.example/benchmark/{name}')


class E5Encoder:
    def __init__(self, directory, threads):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        for name, expected in ARTIFACT_SHA256.items():
            with (directory / name).open('rb') as source:
                if file_digest(source, 'sha256').hexdigest() != expected:
                    raise ValueError(f'{name} does not match the pinned model revision.')
        self.np = np
        self.tokenizer = Tokenizer.from_file(str(directory / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id('<pad>'), pad_token='<pad>')
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        self.model = ort.InferenceSession(str(directory / 'model.onnx'), sess_options=options,
                                          providers=['CPUExecutionProvider'])

    def encode(self, values, role):
        encoded = self.tokenizer.encode_batch([f'{role}: {value}' for value in values])
        arrays = {
            'input_ids': self.np.array([item.ids for item in encoded], dtype=self.np.int64),
            'attention_mask': self.np.array([item.attention_mask for item in encoded], dtype=self.np.int64),
            'token_type_ids': self.np.array([item.type_ids for item in encoded], dtype=self.np.int64),
        }
        hidden, = self.model.run(['last_hidden_state'], {field.name: arrays[field.name] for field in self.model.get_inputs()})
        mask = arrays['attention_mask'][..., None]
        vectors = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
        return vectors / self.np.linalg.norm(vectors, axis=1, keepdims=True)


def date_filter(query):
    ranges = [tuple(map(date.fromisoformat, match.groups())) for match in DATE_RANGE_PATTERN.finditer(query)]
    dates = {date.fromisoformat(day) for day in DATE_PATTERN.findall(DATE_RANGE_PATTERN.sub(' ', query))}
    return lambda day: (not ranges and not dates) or day in dates or any(start <= day <= end for start, end in ranges)


def semantic_candidates(encoder, entries, vectors, case):
    permitted = date_filter(case.query)
    indexes = [i for i, entry in enumerate(entries) if entry.owner == case.owner and permitted(entry.day)]
    if not indexes:
        return []
    query = encoder.encode([case.contextual_query()], 'query')[0]
    similarities = vectors[indexes] @ query
    return sorted(((entries[index].name, float(score)) for index, score in zip(indexes, similarities, strict=True)),
                  key=lambda item: (-item[1], item[0]))


def hybrid_rank(lexical, semantic, entries, threshold):
    scores = defaultdict(float)
    for ranking in (lexical, [name for name, score in semantic if score >= threshold][:20]):
        for rank, name in enumerate(ranking, start=1):
            scores[name] += 1 / (60 + rank)
    return sorted(scores, key=lambda name: (-scores[name], -entries[name].day.toordinal(), name))[:MAX_QA_SOURCES]


def summarize(cases, rankings, entries):
    positive = [len(case.relevant.intersection(rankings[case.name])) / len(case.relevant)
                for case in cases if case.relevant]
    return {
        'queries': len(cases),
        'recall_at_5': round(mean(positive), 4) if positive else None,
        'no_source_queries': sum(not case.relevant for case in cases),
        'false_matches': sum(not case.relevant and bool(rankings[case.name]) for case in cases),
        'ownership_violations': sum(entries[name].owner != case.owner for case in cases for name in rankings[case.name]),
        'date_violations': sum(not case.date_window[0] <= entries[name].day.isoformat() <= case.date_window[1]
                               for case in cases if case.date_window for name in rankings[case.name]),
    }


def timed(operation, samples):
    started = perf_counter()
    result = operation()
    samples.append((perf_counter() - started) * 1000)
    return result


def evaluate(session, encoder, entries, cases):
    by_name = {entry.name: entry for entry in entries}
    by_id = {str(entry.id): entry.name for entry in entries}
    # The bundled passages fit within this bound. Indexing is outside timed retrieval.
    vectors = encoder.encode([entry.content[:1200] for entry in entries], 'passage')

    def lexical(case, query):
        context = retrieve_reflection_journals(session, fixture_uuid(f'owner-{case.owner}'), query)
        return [by_id[source['id']] for source in context.sources]

    def hybrid(case, threshold):
        return hybrid_rank(lexical(case, case.contextual_query()), semantic_candidates(encoder, entries, vectors, case),
                           by_name, threshold)

    development = [case for case in cases if case.split == 'tuning']
    holdout = [case for case in cases if case.split == 'holdout']
    dev_lexical = {case.name: lexical(case, case.contextual_query()) for case in development}
    dev_semantic = {case.name: semantic_candidates(encoder, entries, vectors, case) for case in development}
    max_false = summarize(development, dev_lexical, by_name)['false_matches']
    calibration = {}
    for threshold in THRESHOLDS:
        ranks = {case.name: hybrid_rank(dev_lexical[case.name], dev_semantic[case.name], by_name, threshold)
                 for case in development}
        calibration[threshold] = summarize(development, ranks, by_name)
    threshold = max((value for value, scores in calibration.items() if scores['false_matches'] <= max_false),
                    key=lambda value: (calibration[value]['recall_at_5'], -calibration[value]['false_matches'], value))

    methods = {
        'phase2': lambda case: lexical(case, case.query),
        'contextual_lexical': lambda case: lexical(case, case.contextual_query()),
        'hybrid': lambda case: hybrid(case, threshold),
    }
    results = {}
    rankings = {}
    for method, operation in methods.items():
        samples = []
        ranks = {}
        for case in holdout:
            operation(case)
        for case in holdout:
            for _ in range(3):
                ranks[case.name] = timed(lambda: operation(case), samples)
        rankings[method] = ranks
        results[method] = {
            'overall': summarize(holdout, ranks, by_name),
            'language': {language: summarize([case for case in holdout if case.language == language], ranks, by_name)
                         for language in sorted({case.language for case in holdout})},
            'scenario': {scenario: summarize([case for case in holdout if case.scenario == scenario], ranks, by_name)
                         for scenario in sorted({case.scenario for case in holdout})},
            'p95_ms': round(sorted(samples)[ceil(len(samples) * .95) - 1], 2),
        }

    candidate, baseline = results['hybrid'], results['contextual_lexical']
    gain = round(candidate['overall']['recall_at_5'] - baseline['overall']['recall_at_5'], 4)
    gate = {
        'recall_gain_at_least_10_points': gain >= 0.10,
        'no_language_regression': all(value['recall_at_5'] >= baseline['language'][key]['recall_at_5']
                                      for key, value in candidate['language'].items()),
        'no_false_match_increase': candidate['overall']['false_matches'] <= baseline['overall']['false_matches'],
        'zero_ownership_or_date_violations': all(not result['overall']['ownership_violations']
                                                and not result['overall']['date_violations'] for result in results.values()),
    }
    return {'threshold': threshold, 'tuning': calibration, 'holdout': results, 'rankings': rankings,
            'hybrid_recall_gain': gain, 'gate': gate, 'recommend_embeddings_pilot': all(gate.values())}


def live_check(conversations):
    from dotenv import load_dotenv
    from app.config import groq_api_key, groq_model
    from app.schemas.reflection_chat import ReflectionTurnRequest
    from app.services._groq import JournalSummaryError
    from app.services.reflection_chat import ReflectionChatAssistant

    load_dotenv(ROOT / '.env')
    if not groq_api_key():
        raise ValueError('GROQ_API_KEY is required for --live.')
    assistant = ReflectionChatAssistant()
    results = []
    if len(conversations) != 3:
        raise ValueError('Expected exactly three bundled live conversations.')
    for case in conversations:
        payload = ReflectionTurnRequest(turn_id=uuid4(), expected_revision=1, message=case['message'], locale=case['locale'])
        history = [{'message': case['prior_message'], 'reply': case['prior_reply']}]
        result = {'expected': case['expected']}
        try:
            outcome = assistant.classify(payload, history).outcome
            reply = assistant.reflect(payload, history, []).reply if outcome == 'reflection' else None
            result.update(outcome=outcome, reply=reply)
        except JournalSummaryError as error:
            result['error'] = type(error).__name__
        results.append(result)
    return {'model': groq_model(), 'review_manually': results}


def live_routing_cases(cases):
    selected = []
    for language in ('en', 'vi', 'mixed'):
        eligible = [case for case in cases if case.split == 'holdout' and case.language == language]
        for scenario, limit in (('follow_up', 2), ('topic_change', 1), ('date', 1)):
            selected.extend([case for case in eligible if case.scenario == scenario][:limit])
    if len(selected) != 12:
        raise ValueError('Expected exactly 12 bundled routing cases.')
    return selected


def routing_question(case):
    if case.scenario == 'follow_up':
        return case.query
    framing = (' Help me reflect on that experience.' if case.language == 'en'
               else ' Mình muốn nhìn lại trải nghiệm đó.')
    return case.query + framing


def routing_prior(case):
    return case.prior or 'I was reflecting on my last afternoon.'


def classify_live_routes(cases):
    from dotenv import load_dotenv
    from app.config import groq_api_key, groq_model
    from app.schemas.reflection_chat import ReflectionTurnRequest
    from app.services._groq import JournalSummaryError
    from app.services.reflection_chat import ReflectionChatAssistant

    load_dotenv(ROOT / '.env')
    if not groq_api_key():
        raise ValueError('GROQ_API_KEY is required for --live-routing.')
    assistant = ReflectionChatAssistant()
    decisions = {}
    for case in cases:
        locale = 'en' if case.language == 'en' else 'vi'
        payload = ReflectionTurnRequest(turn_id=uuid4(), expected_revision=1, message=routing_question(case), locale=locale)
        history = [{'message': routing_prior(case),
                    'reply': 'What did you notice?' if locale == 'en' else 'Bạn nhận thấy điều gì?'}]
        try:
            decisions[case.name] = assistant.classify(payload, history).model_dump()
        except JournalSummaryError as error:
            cause = error.__cause__
            status = getattr(cause, 'status_code', None)
            failure = {'error': type(error).__name__}
            if isinstance(status, int):
                failure['provider_status'] = status
            decisions[case.name] = failure
    return groq_model(), decisions


def evaluate_live_routes(session, entries, cases, decisions):
    by_name = {entry.name: entry for entry in entries}
    by_id = {str(entry.id): entry.name for entry in entries}
    baseline, routed, rows = {}, {}, []
    for case in cases:
        owner = fixture_uuid(f'owner-{case.owner}')
        decision = decisions[case.name]
        expected = 'previous_user_message' if case.scenario == 'follow_up' else 'current_message'
        hint = decision.get('search_context')
        question = routing_question(case)
        baseline[case.name] = [by_id[source['id']] for source in
                               retrieve_reflection_journals(session, owner, question).sources]
        sources = []
        if decision.get('outcome') == 'reflection':
            prior = routing_prior(case) if hint == 'previous_user_message' else None
            sources = retrieve_reflection_journals(session, owner, question, previous_user_message=prior).sources
        routed[case.name] = [by_id[source['id']] for source in sources]
        rows.append({'case': case.name, 'scenario': case.scenario, 'expected_hint': expected, **decision,
                     'passed': decision.get('outcome') == 'reflection' and hint == expected,
                     'selected': routed[case.name], 'relevant': sorted(case.relevant)})
    return {'checks': rows, 'baseline': summarize(cases, baseline, by_name),
            'classifier_routed': summarize(cases, routed, by_name)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--model-dir', type=Path, help='Local directory with model.onnx and tokenizer.json from the pinned revision')
    mode.add_argument('--live', action='store_true', help='Send three bundled fictional follow-ups to Groq, up to nine calls')
    mode.add_argument('--live-routing', action='store_true', help='Compare production lexical retrieval with up to 12 fictional Groq classifications')
    parser.add_argument('--routing-case', action='append', help='With --live-routing, rerun a named case (repeatable)')
    parser.add_argument('--threads', default=2, type=int, choices=range(1, 9), help='ONNX CPU intra-op threads (default: 2)')
    args = parser.parse_args()
    if args.routing_case and not args.live_routing:
        parser.error('--routing-case requires --live-routing.')
    fixtures = json.loads(FIXTURES.read_text(encoding='utf-8'))
    if args.live:
        report = live_check(fixtures['live_conversations'])
        print(json.dumps(report, indent=2))
        return int(any('error' in case for case in report['review_manually']))

    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        parser.error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.')
    if set(fixtures['queries']) != {'en', 'vi', 'mixed'} or any(len(items) != 20 for items in fixtures['queries'].values()):
        parser.error('Expected 20 bundled queries in each of the three language groups.')
    entries = [Entry(name, owner, date.fromisoformat(day), content) for name, owner, day, content in fixtures['entries']]
    cases = [Case(f'{lang}-{index:02}', lang, 'tuning' if index <= 6 else 'holdout', owner, scenario, query,
                  frozenset(relevant), *optional)
             for lang, items in fixtures['queries'].items()
             for index, (owner, scenario, query, relevant, *optional) in enumerate(items, start=1)]
    engine = make_engine(url)
    try:
        if args.live_routing:
            cases = live_routing_cases(cases)
            if args.routing_case:
                selected = set(args.routing_case)
                if not selected <= {case.name for case in cases}:
                    parser.error('Unknown live routing case.')
                cases = [case for case in cases if case.name in selected]
            model, decisions = classify_live_routes(cases)
        else:
            encoder = E5Encoder(args.model_dir, args.threads)
        with engine.connect() as db, db.begin() as transaction:
            schema = f'reflection_benchmark_{uuid4().hex}'
            db.execute(text(f'CREATE SCHEMA {schema}'))
            db.execute(text(f'SET LOCAL search_path TO {schema}'))
            User.__table__.create(db)
            JournalEntry.__table__.create(db)
            db.execute(User.__table__.insert(), [
                {'id': fixture_uuid(f'owner-{key}'), 'email': f'{key}@example.test', 'password_hash': '!fictional'}
                for key in sorted({entry.owner for entry in entries})
            ])
            db.execute(JournalEntry.__table__.insert(), [
                {'id': entry.id, 'user_id': fixture_uuid(f'owner-{entry.owner}'), 'content': entry.content,
                 'journal_date': entry.day} for entry in entries
            ])
            with Session(bind=db) as session:
                if args.live_routing:
                    results = evaluate_live_routes(session, entries, cases, decisions)
                else:
                    results = evaluate(session, encoder, entries, cases)
            transaction.rollback()  # Removes the fixture schema and data, including on exceptions.
    finally:
        engine.dispose()
    if args.live_routing:
        print(json.dumps({'model': model, **results}, indent=2))
        metrics = results['classifier_routed']
        return int(not all(check['passed'] for check in results['checks']) or metrics['ownership_violations'] > 0
                   or metrics['date_violations'] > 0)
    report = {'model': f'intfloat/multilingual-e5-small@{MODEL_REVISION}', 'fixture_sha256': sha256(FIXTURES.read_bytes()).hexdigest(),
              'platform': platform.platform(), 'cpu_threads': args.threads, 'tuning_count': 18, 'holdout_count': 42,
              'versions': {dependency: version(dependency) for dependency in ('numpy', 'onnxruntime', 'tokenizers')},
              **results}
    print(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
