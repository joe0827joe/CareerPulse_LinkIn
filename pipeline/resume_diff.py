"""Offline-only resume review pipeline. Python standard library; no website writes."""
import argparse
import copy
import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TARGET = ROOT / 'pipeline' / 'linkedin_profile_target_en_US.json'

def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def norm(value):
    # Preserve meaningful whitespace, case, punctuation, numbers and bullet structure.
    if isinstance(value, str):
        return unicodedata.normalize('NFC', value.replace('\r\n', '\n').replace('\r', '\n')).strip()
    return value

def values_match(observation_value, wanted, source_kind=None):
    """Compare editor/display captures without erasing meaningful text globally.

    LinkedIn's contenteditable control serializes one blank line as several
    line-break nodes.  Limit whitespace folding to extension captures so source
    JSON and manual snapshots retain the stricter comparison semantics.
    """
    if source_kind in ('extension_live_display', 'extension_saved_form') and isinstance(observation_value, str) and isinstance(wanted, str):
        return re.sub(r'\s+', ' ', norm(observation_value)) == re.sub(r'\s+', ' ', norm(wanted))
    return norm(observation_value) == norm(wanted)

def route(url):
    return urlsplit(url).path.rstrip('/')

def observation(value, event, kind, complete=True):
    return dict(value=value, complete=complete, source_kind=kind,
                source_seq=event.get('seq'), captured_at=event.get('at'),
                source_url=event.get('url'), published_confirmed=kind == 'display',
                locale='unknown')

def extract(logger, target):
    profile = target['profile_url'].rstrip('/') + '/'
    pages = [e for e in logger['timeline'] if e.get('type') == 'page_summary'
             and e.get('url', '').startswith(profile)]
    if not pages:
        raise ValueError('Logger 沒有目標個人檔案的 page_summary')
    result = dict(schema_version='1.0', artifact_type='resume_snapshot', profile_url=profile,
                  captured_at=logger.get('exported_at'), records={}, skills=dict(items=[], complete=False),
                  logger_stats=dict(events=len(logger['timeline']), fields=len(logger.get('field_schema', [])),
                                    dropped=logger.get('session', {}).get('dropped_event_count')))
    records = result['records']
    for op in target['operations']:
        records[op['id']] = dict(section=op['section'], url=op['url'], exists=None,
                                 fields={}, mapping={}, preserve=[], identity_confirmed=False)
    records['headline'] = dict(section='headline', fields={}, mapping={}, preserve=[])
    # Display-only About and headline: never infer form saves from click/HTTP success.
    for e in pages:
        if route(e['url']) != route(profile):
            continue
        for b in e.get('buttons', []):
            if b.get('href') == profile and '\n\n' in b.get('text', ''):
                name, text = b['text'].split('\n\n', 1)
                if name == e.get('title', '').split(' | ')[0] and text and '\n' not in text and not text.startswith('•'):
                    records['headline']['fields']['text'] = observation(text, e, 'display')
        body = e.get('body_text', '')
        m = re.search(r'\n關於\n\n(.*?)\n(?:… 更多\n\n)?動態\n', body, re.S)
        if m and 'about' in records:
            value = m.group(1).removesuffix('… 更多\n').strip()
            records['about']['fields']['description'] = observation(value, e, 'display', '… 更多' not in m.group(1))
            records['about']['exists'] = True
            records['about']['identity_confirmed'] = True
    # Stable entity URL -> identity observed on display page. No title-only joins.
    for op in target['operations']:
        rec = records[op['id']]
        for e in pages:
            for b in e.get('buttons', []):
                if route(b.get('href', '')) == route(op['url']) and op['operation'] != 'create':
                    if b.get('text') and not b['text'].startswith('編輯'):
                        rec['identity'] = b['text']
                        rec['identity_confirmed'] = True
                        rec['exists'] = True
        # Form extraction must use exact entity URL; new/ is schema only, never absence proof.
        for e in pages:
            if route(e['url']) != route(op['url']):
                continue
            for f in e.get('field_inventory', {}).get('fields', []):
                label = f.get('label', '')
                placeholder = f.get('placeholder', '')
                key = None
                if placeholder == '職稱': key = 'position_title'
                elif placeholder == '組織名稱': key = 'organization'
                elif label.startswith('專案名稱'): key = 'name'
                elif label.startswith('說明'): key = 'description'
                elif label == '工作類型': key = 'employment_type'
                elif label.startswith('開始月份'): key = 'start_month'
                elif label.startswith('開始年份'): key = 'start_year'
                elif label == '我目前擔任此職務': key = 'current_position'
                if not key: continue
                rec['mapping'][key] = dict(label=label, placeholder=placeholder, tag=f.get('tag'),
                                          contenteditable=f.get('contenteditable'), source_seq=e['seq'])
                v = f.get('value', {})
                if op['operation'] == 'create' or not v.get('captured') or v.get('redacted'): continue
                value = v.get('value')
                if key in ('start_year', 'start_month') and str(value).isdigit(): value = int(value)
                if key == 'current_position': value = f.get('control', {}).get('checked')
                rec['fields'][key] = observation(value, e, 'form')
        # Promote form values only when also present in the same entity's display page.
        for key, obs in rec['fields'].items():
            if obs['source_kind'] != 'form' or not isinstance(obs['value'], str) or not obs['value']: continue
            for e in pages:
                if '/edit/' in e['url']: continue
                if not any(route(b.get('href', '')) == route(op['url']) for b in e.get('buttons', [])): continue
                if obs['value'] in e.get('body_text', ''):
                    obs.update(source_kind='display', published_confirmed=True, source_seq=e['seq'], source_url=e['url'])
    # Known Chinese display layout: extract full descriptions only between exact identity and skill footer.
    patterns = {'everlight': (r'負責高功率 LED', r'熱管理、製程改善'),
                'chicony': (r'負責高效率馬達', r'CNC Turning & Milling、NC Programming')}
    for ident, (start, end) in patterns.items():
        if ident not in records: continue
        for e in pages:
            if '/details/experience/' not in e['url'] or '/edit/' in e['url']: continue
            if not any(route(b.get('href', '')) == route(records[ident]['url']) for b in e.get('buttons', [])): continue
            m = re.search('(' + start + r'.*?)\n\n' + end, e.get('body_text', ''), re.S)
            if m: records[ident]['fields']['description'] = observation(m.group(1).strip(), e, 'display')
    # Keep all other original fields and media outside the patch, including unparsed controls.
    for op in target['operations']:
        rec = records[op['id']]
        rec['preserve'] = ['未列於差異中的全部欄位', '原有日期、公司、正式職稱（非新增項目）', '原有技能關聯、媒體與連結']
        if op['section'] == 'about' and 'description' not in rec['mapping']:
            rec['mapping']['description'] = dict(status='unverified', reason='未擷取到可辨識 About 控制項')
    result['warnings'] = ['Logger 是歷史觀察，未擷取不代表不存在。',
                          '介面語言不等於履歷語言；所有語言均需另行確認。',
                          'Skills 清單不完整；不據此新增或移除技能。',
                          '相同文字僅表示內容一致，不是履歷事實的獨立證明。']
    return result

def extract_audit_logger(logger, target):
    """Convert the read-only browser extension export into the canonical snapshot."""
    profile = logger.get('meta', {}).get('profile_url')
    if not profile or profile.rstrip('/') != target['profile_url'].rstrip('/'):
        raise ValueError('插件 Logger 的个人档案不符')
    locale = target.get('profile_locale', 'zh_TW')
    locale_data = logger.get('locales', {}).get(locale, logger)
    if logger.get('locales') and locale not in logger['locales']:
        raise ValueError(f'插件 Logger 尚未扫描目标语言：{locale}')
    result = dict(schema_version='1.0', artifact_type='resume_snapshot', profile_url=profile,
                  profile_locale=locale,
                  captured_at=max((v.get('captured_at','') for v in locale_data.values() if isinstance(v,dict)), default=''),
                  capture_method='linkedin_profile_audit_extension', records={},
                  skills=copy.deepcopy(logger.get('skills', {'items':[], 'complete':False})), warnings=[])
    for op in target['operations']:
        result['records'][op['id']] = dict(section=op['section'], url=op['url'], exists=None,
            fields={}, mapping={}, preserve=['未列于差异中的全部字段','原有日期、技能关联、媒体与链接'], identity_confirmed=False)
    result['records']['headline'] = dict(section='headline', fields={}, mapping={}, preserve=[], identity_confirmed=True)
    def live(value, section, complete=True):
        src = locale_data.get(section, {})
        return dict(value=value, complete=complete, source_kind='extension_live_display',
                    captured_at=src.get('captured_at'), source_url=src.get('source_url'),
                    published_confirmed=bool(src.get('published_confirmed')), locale='unknown')
    def saved_form(value, event):
        """A visible-form Save click followed by the logger's next scan.

        This is deliberately distinct from a display scrape: it proves the value
        supplied to LinkedIn's visible editor and that the extension later saw a
        published section, but does not independently prove every rendered word.
        """
        return dict(value=value, complete=True, source_kind='extension_saved_form',
                    captured_at=event.get('at'), source_url=event.get('url'),
                    published_confirmed=True, locale=event.get('locale', 'unknown'))
    def inspected_form(value, event):
        return dict(value=value, complete=True, source_kind='extension_form_inspection',
                    captured_at=event.get('at'), source_url=event.get('url'),
                    published_confirmed=False, locale=event.get('locale', 'unknown'))
    def last_saved(action):
        candidates = [event for event in logger.get('change_history', [])
                      if event.get('locale') == locale and event.get('action') == action
                      and event.get('save_requested') and event.get('status') == 'save_clicked']
        return candidates[-1] if candidates else None
    def saved_value(event, field):
        if not event: return None
        items = event.get('after', [])
        if field == 'position_title':
            item = next((x for x in items if x.get('placeholder') in ('職稱', 'Title') or
                         re.search(r'職稱|title', x.get('label') or '', re.I)), None)
        elif field == 'organization':
            item = next((x for x in items if x.get('placeholder') in ('組織名稱', 'Organization') or
                         re.search(r'組織|organization|company', x.get('label') or '', re.I)), None)
        elif field == 'description':
            item = next((x for x in items if x.get('tag') in ('div', 'textarea') and
                         ('說明' in (x.get('aria') or '') or (x.get('aria') or '') in ('關於', 'About'))), None)
        elif field == 'employment_type':
            item = next((x for x in items if x.get('tag') == 'select' and
                         ('工作類型' in (x.get('label') or '') or 'employment type' in (x.get('label') or '').lower())), None)
            if item:
                return {'正職員工': 'Full-time', '全職': 'Full-time'}.get(item.get('selected_text'), item.get('selected_text'))
        elif field in ('start_month', 'start_year'):
            expected = '開始月份' if field == 'start_month' else '開始年份'
            item = next((x for x in items if x.get('tag') == 'select' and expected in (x.get('label') or '')), None)
            if item:
                match = re.search(r'\d+', str(item.get('selected_text') or item.get('value') or ''))
                return int(match.group()) if match else None
        elif field == 'current_position':
            month_index = next((i for i, x in enumerate(items) if x.get('tag') == 'select' and
                                '開始月份' in (x.get('label') or '')), None)
            item = items[month_index - 1] if month_index and items[month_index - 1].get('type') == 'checkbox' else None
            if item is not None:
                return bool(item.get('checked'))
        else:
            item = None
        return item.get('value') if item and item.get('value') is not None else None
    shared_operation_ids = set(target.get('shared_content_operation_ids', []))
    def last_inspection(url, allow_shared_locale=False):
        candidates = [event for event in logger.get('form_inspections', [])
                      if (allow_shared_locale or event.get('locale') == locale)
                      and route(event.get('url', '')) == route(url)]
        return candidates[-1] if candidates else None
    overview = locale_data.get('overview', {})
    if overview.get('headline') is not None:
        result['records']['headline']['fields']['text'] = live(overview['headline'],'overview')
        result['records']['headline']['mapping']['text'] = {'status':'verified','source':'published top card'}
    about = result['records'].get('about')
    if about is not None and overview.get('about') is not None:
        about.update(exists=True, identity_confirmed=True)
        about['fields']['description'] = live(overview['about'],'overview')
        about['mapping']['description'] = {'status':'verified','source':'published About section'}
    saved_about = last_saved('about')
    saved_about_value = saved_value(saved_about, 'description')
    if about is not None and saved_about_value is not None:
        about.update(exists=True, identity_confirmed=True)
        about['fields']['description'] = saved_form(saved_about_value, saved_about)
        about['mapping']['description'] = {'status':'verified', 'source':'visible About form saved, then re-scanned'}
    experience = locale_data.get('experience', {})
    quanta = result['records'].get('quanta')
    if quanta is not None and experience.get('quanta_present') is False:
        quanta.update(exists=False, identity_confirmed=True)
    if quanta is not None and experience.get('quanta_present') is True:
        quanta.update(exists=True, identity_confirmed=True)
    saved_quanta = last_saved('quanta')
    if quanta is not None and saved_quanta:
        quanta.update(exists=True, identity_confirmed=True)
        for field in ('position_title', 'organization', 'employment_type', 'start_month', 'start_year', 'current_position', 'description'):
            value = saved_value(saved_quanta, field)
            if value is not None:
                quanta['fields'][field] = saved_form(value, saved_quanta)
                quanta['mapping'][field] = {'status':'verified', 'source':'visible Experience form saved, then re-scanned'}
    if quanta is not None:
        inspection = last_inspection(quanta['url'], allow_shared_locale='quanta' in shared_operation_ids)
        if inspection:
            quanta.update(exists=True, identity_confirmed=True)
            for field in ('position_title', 'organization', 'employment_type', 'start_month', 'start_year', 'current_position', 'description'):
                if field in quanta['fields']:
                    continue
                value = saved_value({'after': inspection.get('fields', [])}, field)
                if value is not None:
                    quanta['fields'][field] = inspected_form(value, inspection)
                    quanta['mapping'][field] = {'status':'verified', 'source':'read-only visible Experience form inspection; publication not inferred'}
    exp_patterns = {
        'everlight': (r'(負責高功率 LED[\s\S]*?)(?:\n\n\s*熱管理、製程改善|$)'),
        'chicony': (r'(負責高效率馬達[\s\S]*?)(?:\n\n\s*CNC Turning & Milling|$)')
    }
    for ident, pattern in exp_patterns.items():
        text = experience.get(ident)
        rec = result['records'].get(ident)
        if not text or rec is None: continue
        rec.update(exists=True, identity_confirmed=True)
        expected = next((op['fields'].get('description') for op in target['operations'] if op['id'] == ident), None)
        # The live card contains title/company/dates around the description.  If
        # the complete approved description is present, record that exact span
        # rather than guessing boundaries from a locale-specific footer.
        if expected and re.sub(r'\s+', ' ', expected) in re.sub(r'\s+', ' ', text):
            rec['fields']['description'] = live(expected, 'experience')
            rec['mapping']['description'] = {'status':'verified','source':'complete approved description found on published Experience card'}
            continue
        m = re.search(pattern, text, re.S)
        if m: rec['fields']['description'] = live(m.group(1).strip(),'experience')
        rec['mapping']['description'] = {'status':'verified','source':'stable edit URL on published Experience page'}
    projects = locale_data.get('projects', {})
    project_text = projects.get('customer_service')
    project = result['records'].get('customer_service')
    if project_text and project is not None:
        blocks = [x.strip() for x in re.split(r'\n\s*\n', project_text) if x.strip()]
        project.update(exists=True, identity_confirmed=True)
        expected_project = next((op for op in target['operations'] if op['id'] == 'customer_service'), None)
        if expected_project:
            expected_fields = expected_project['fields']
            if expected_fields.get('name') and expected_fields['name'] in project_text:
                project['fields']['name'] = live(expected_fields['name'], 'projects')
                project['mapping']['name'] = {'status':'verified','source':'complete approved project name found on published card'}
            if expected_fields.get('description') and re.sub(r'\s+', ' ', expected_fields['description']) in re.sub(r'\s+', ' ', project_text):
                project['fields']['description'] = live(expected_fields['description'], 'projects')
                project['mapping']['description'] = {'status':'verified','source':'complete approved project description found on published card'}
        if blocks:
            project['fields'].setdefault('name', live(blocks[0],'projects'))
            project['mapping'].setdefault('name', {'status':'verified','source':'stable edit URL on published Projects page'})
        description = next((x for x in blocks[1:] if not re.match(r'^\d{4}\s*年',x) and
                            not x.startswith('…') and '以及其他' not in x), None)
        if description:
            description = re.sub(r'\s*…\s*更多\s*$', '', description).strip()
            project['fields'].setdefault('description', live(description,'projects'))
            project['mapping'].setdefault('description', {'status':'verified','source':'published project card'})
    result['warnings'] = ['插件只读取已发布页面，不证明履历事实。','履历语言仍需人工确认。',
                          'extension_saved_form 表示可见表单已按下 Save 且随后完成区段扫描；仍应保留 Logger 作为可复核记录。']
    return result

ALLOWED = {'about': {'description'}, 'headline': {'text'},
           'experience': {'position_title','organization','employment_type','start_month','start_year','current_position','description'},
           'project': {'name','description'}, 'skills': {'items'}}

def validate_target(target):
    if target.get('artifact_type') != 'linkedin_profile_patch': raise ValueError('不是履歷目標 JSON')
    primary = target.get('shared_content_primary_locale')
    if primary not in ('zh_TW', 'en_US'): raise ValueError('共享內容主語言無效')
    shared_ids = target.get('shared_content_operation_ids')
    if not isinstance(shared_ids, list) or not shared_ids or len(shared_ids) != len(set(shared_ids)):
        raise ValueError('共享內容 operation 清單無效')
    ids = set()
    for op in target['operations']:
        if op['id'] in ids: raise ValueError('重複 operation id')
        ids.add(op['id'])
        if op['operation'] not in ('create', 'replace'): raise ValueError('只允許 create/replace 計畫')
        if op['section'] not in ALLOWED or not op['fields']: raise ValueError('未知 section 或空 fields')
        if not set(op['fields']) <= ALLOWED[op['section']]: raise ValueError('未知欄位映射')
        if not op['url'].startswith(target['profile_url']): raise ValueError('目標個人檔案不一致')
        for key, value in op['fields'].items():
            if key in ('start_month','start_year'):
                if type(value) is not int: raise ValueError('日期必須為整數')
                if key == 'start_month' and not 1 <= value <= 12: raise ValueError('月份範圍錯誤')
                if key == 'start_year' and not 1900 <= value <= datetime.now().year: raise ValueError('年份範圍錯誤')
            elif key == 'current_position':
                if type(value) is not bool: raise ValueError('現職欄位必須為布林值')
            elif key == 'items':
                if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value): raise ValueError('技能必須為文字陣列')
            elif not isinstance(value, str) or not value.strip(): raise ValueError('空白或非文字目標')
    if not set(shared_ids) <= ids: raise ValueError('共享內容 operation 必須是已批准目標')

def compare(snapshot, target, reviews=None):
    validate_target(target)
    if snapshot.get('artifact_type') != 'resume_snapshot': raise ValueError('快照格式錯誤')
    if snapshot.get('profile_url','').rstrip('/') != target['profile_url'].rstrip('/'): raise ValueError('快照個人檔案不符')
    reviews = reviews or {}
    changes, unchanged, pending, rollback, policy_exceptions = [], [], [], [], []
    primary_locale = target['shared_content_primary_locale']
    is_non_primary_shared_target = target.get('profile_locale') != primary_locale
    shared_operation_ids = set(target['shared_content_operation_ids'])
    for op in target['operations']:
        rec = snapshot.get('records', {}).get(op['id'], {})
        review = reviews.get(op['id'], {})
        review_valid = (review.get('target_sha256') == digest(op) and review.get('snapshot_sha256') == digest(snapshot)
                        and bool(review.get('evidence')) and bool(review.get('reviewer')))
        for field, wanted in op['fields'].items():
            old = rec.get('fields', {}).get(field)
            known = bool(old and old.get('complete') and old.get('published_confirmed'))
            form_verified = bool(old and old.get('complete') and old.get('source_kind') == 'extension_form_inspection')
            if (known or form_verified) and rec.get('identity_confirmed') and values_match(old['value'], wanted, old.get('source_kind')):
                unchanged.append(dict(id=op['id'], field=field,
                                      verification='published' if known else 'visible_form'))
                continue
            # LinkedIn has been observed to share these records across language
            # views.  The explicit contract policy selects the primary locale;
            # a non-primary target is reported for audit, never proposed as a
            # second conflicting write.
            if is_non_primary_shared_target and op['id'] in shared_operation_ids:
                policy_exceptions.append(dict(
                    id=op['id'], section=op['section'], field=field,
                    before=old['value'] if old else None, before_known=known,
                    non_primary_target=wanted, primary_locale=primary_locale,
                    status='shared_primary_language',
                    reason=f'LinkedIn shared field; {primary_locale} is the approved primary locale. No non-primary write is proposed.',
                    source=old, mapping=rec.get('mapping', {}).get(field)))
                continue
            reasons = []
            if not known: reasons.append('舊值不完整或未確認已發布；不可將未知當成空白')
            if not rec.get('identity_confirmed'): reasons.append('記錄身分／新增前去重待確認')
            if op['operation'] == 'create' and rec.get('exists') is not False and not rec.get('identity_confirmed'):
                reasons.append('尚未證明此經歷不存在；不要直接重複新增')
            mapping = rec.get('mapping', {}).get(field)
            if not mapping or mapping.get('status') == 'unverified': reasons.append('欄位映射待人工確認')
            if not review_valid or not review.get('facts_confirmed'): reasons.append('履歷事實待人工確認（目標 JSON 的 evidence 不是獨立證據）')
            if not review_valid or not review.get('locale_confirmed'): reasons.append('目標履歷語言待人工確認')
            if old and re.search(r'[\u4e00-\u9fff]', str(old['value'])) and not re.search(r'[\u4e00-\u9fff]', str(wanted)):
                reasons.append('中文改英文：請確認保留另一語言版本')
            limit = 2000 if field == 'description' and op['section'] in ('experience','project') else (255 if field == 'name' else None)
            length = len(wanted.encode('utf-16-le')) // 2 if isinstance(wanted, str) else None
            if limit and length > limit: reasons.append('超過 Logger 已觀察欄位字元上限')
            item = dict(id=op['id'], section=op['section'], field=field, before=old['value'] if old else None,
                        before_known=known, after=wanted, url=rec.get('url',op['url']),
                        status='pending_review' if reasons else 'ready_for_manual_fill', reasons=reasons,
                        source=old, mapping=mapping, utf16_length=length, observed_limit=limit,
                        target_sha256=digest(op), snapshot_sha256=digest(snapshot))
            changes.append(item)
            if known:
                rollback.append(dict(id=op['id'], field=field, expected_current=wanted, restore=old['value'],
                                     source=old, manual_only=True))
    for follow in target.get('manual_follow_ups', []):
        section = follow['section']
        if section == 'headline': continue
        if section == 'skills':
            skills = snapshot.get('skills', {})
            have = {norm(x) for x in skills.get('items', [])}
            for skill in follow['recommendation']:
                if norm(skill) not in have:
                    pending.append(dict(section='skills', item=skill,
                                        status='missing_candidate' if skills.get('complete') else 'unknown',
                                        reason='僅建議清單，尚非已批准新增／排序目標'))
        else:
            pending.append(dict(section=section, status='undefined_target', reason=follow['recommendation']))
    return dict(schema_version='1.0', changes=changes, unchanged=unchanged, follow_ups=pending,
                policy_exceptions=policy_exceptions,
                rollback=rollback, target_diff_zero=not changes,
                complete=not changes and not pending,
                scope='只有明確 operations 可收斂；Skills/Projects 建議必須先定義或移除，不可自動視為完成')

def render(result):
    lines = ['# 履歷差異更新清單', '', '離線產生；供人工審核與填寫，未提交任何網站修改。', '',
             f"差異欄位 {len(result['changes'])}；一致欄位 {len(result['unchanged'])}；後續項目 {len(result['follow_ups'])}；共享語言政策例外 {len(result.get('policy_exceptions', []))}。",
             f"明確目標零差異：{result['target_diff_zero']}；全部完成：{result['complete']}。", '',
             '只修改下列欄位，其餘原值、日期、技能關聯與媒體全部保留。before=null 表示未知，不能拿來清空欄位。', '']
    for c in result['changes']:
        lines += [f"## {c['id']} / {c['field']}", '', f"狀態：{c['status']}", '',
                  '；'.join(c['reasons']) or '可人工填寫', '', '原值：', '', str(c['before']) if c['before'] is not None else '（未知）', '',
                  '候選新值（確認後才填寫）：', '', str(c['after']), '',
                  f"原值來源：{(c['source'] or {}).get('source_seq', '未擷取')}；可完整回復：{c['before_known']}", '']
    lines += ['## 保留與後續確認', '', 'Headline：未指定修改，保留；尚未出現在目標的欄位與專案全部保留。', '']
    for item in result['follow_ups']:
        lines.append(f"- {item['section']} / {item.get('item','')}：{item['status']} — {item['reason']}")
    if result.get('policy_exceptions'):
        lines += ['', '## 共享內容語言政策', '']
        for item in result['policy_exceptions']:
            lines.append(f"- {item['id']} / {item['field']}：{item['status']} — {item['reason']}")
    return '\n'.join(lines) + '\n'

def run(source, target_path, out_root, reviews_path=None):
    raw, target = read(source), read(target_path)
    validate_target(target)
    artifact = raw.get('artifact_type') or raw.get('meta', {}).get('artifact_type')
    if artifact == 'web_interface_discovery':
        snapshot = extract(raw, target)
    elif artifact == 'linkedin_profile_audit_logger':
        snapshot = extract_audit_logger(raw, target)
    else:
        snapshot = raw
    reviews = read(reviews_path) if reviews_path else {}
    result = compare(snapshot, target, reviews)
    now = datetime.now(timezone(timedelta(hours=8))).isoformat()
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    # Unique immutable-by-convention directories; never overwrite an earlier run.
    name = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%dT%H%M%S%f')
    folder = out_root / name
    folder.mkdir(exist_ok=False)
    write(folder / 'snapshot.json', snapshot)
    write(folder / 'target.json', target)
    # Archive the actual offline input as well: preserves unknown fields for later re-extraction.
    # This raw file may contain private logger data; it stays local and is never rendered in review.md.
    (folder / 'source_input.json').write_bytes(Path(source).read_bytes())
    write(folder / 'reviews.json', reviews)
    write(folder / 'diff.json', result)
    write(folder / 'rollback.json', dict(manual_only=True, changes=result['rollback'],
          warning='先核對現值等於 expected_current，再人工還原。未知舊值無法自動回復；新增記錄不自動刪除。'))
    (folder / 'review.md').write_text(render(result), encoding='utf-8')
    review_template = {op['id']: dict(target_sha256=digest(op), snapshot_sha256=digest(snapshot),
                       facts_confirmed=False, locale_confirmed=False, evidence='', reviewer='') for op in target['operations']}
    write(folder / 'review_template.json', review_template)
    previous = sorted(p for p in out_root.iterdir() if p.is_dir() and p != folder and (p / 'snapshot.json').exists())
    transitions = []
    if previous:
        before = read(previous[-1] / 'snapshot.json')
        for ident in sorted(set(before.get('records', {})) | set(snapshot.get('records', {}))):
            a = before.get('records', {}).get(ident, {}).get('fields', {})
            b = snapshot.get('records', {}).get(ident, {}).get('fields', {})
            for key in sorted(set(a) | set(b)):
                if a.get(key, {}).get('value') != b.get(key, {}).get('value'):
                    transitions.append(dict(id=ident, field=key, before=a.get(key), after=b.get(key),
                                            note='觀察差異；不推斷由本工具修改'))
    write(folder / 'observed_changes.json', transitions)
    manifest = dict(created_at=now, source_file=str(Path(source).resolve()),
                    source_sha256=hashlib.sha256(Path(source).read_bytes()).hexdigest(),
                    previous_run=previous[-1].name if previous else None,
                    files={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()})
    write(folder / 'manifest.json', manifest)
    with (out_root / 'history.jsonl').open('a', encoding='utf-8') as f:
        f.write(json.dumps(dict(run=name, created_at=now, changes=len(result['changes']), complete=result['complete']), ensure_ascii=False) + '\n')
    return folder, result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True, help='Logger 或 canonical snapshot JSON')
    parser.add_argument('--target', default=str(DEFAULT_TARGET))
    parser.add_argument('--reviews')
    parser.add_argument('--out', default=str(ROOT / 'runs'))
    args = parser.parse_args()
    folder, result = run(args.snapshot, args.target, args.out, args.reviews)
    print(json.dumps(dict(run=str(folder), changes=len(result['changes']), unchanged=len(result['unchanged']),
                         follow_ups=len(result['follow_ups']), policy_exceptions=len(result.get('policy_exceptions', [])),
                         complete=result['complete']), ensure_ascii=True))

if __name__ == '__main__':
    main()
