#!/usr/bin/env python3
"""Extract the user-supplied, proofread Word book into lossless reference data.

Raw source lines are retained alongside searchable structured fields. Clinical
claims and quantities are transcribed from the document, never inferred.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from docx import Document


PARTS = [
    (5, 'tim-mach', 'Tim mạch'),
    (14, 'ho-hap', 'Hô hấp'),
    (24, 'gan', 'Gan'),
    (30, 'tiet-nieu', 'Tiết niệu'),
    (47, 'khop', 'Khớp'),
    (61, 'san-phu-khoa', 'Sản phụ khoa'),
    (79, 'mun-nhot-viem-co', 'Mụn nhọt và viêm cơ'),
    (87, 'truyen-nhiem', 'Bệnh truyền nhiễm'),
    (102, 'tieu-hoa', 'Tiêu hóa'),
    (127, 'ngoai-da', 'Ngoài da'),
]
PART_BY_PAGE = {p: (i+1, slug, name) for i, (p, slug, name) in enumerate(PARTS)}
HEADER = 'Những bài thuốc quý trong dân gian'
RECIPE = re.compile(r'^\+?\s*Bài thuốc\s+(?:số\s+)?(\d+)\s*[:.]?$', re.I)
SUBHEAD = re.compile(r'^([IVX]+)\.\s+(.+)')
SECTION = re.compile(r'^[\-—–*]\s*(Cách (?:chế biến(?: và)? )?sử dụng|Công dụng|Liều dùng|Nhận xét|Kiêng)\s*[:;]\s*(.*)$', re.I)


def plain(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def no_accents(text: str) -> str:
    text = text.replace('đ', 'd').replace('Đ', 'D')
    return ''.join(ch for ch in unicodedata.normalize('NFD', text) if unicodedata.category(ch) != 'Mn').lower()


def read_pages(path: Path):
    doc = Document(path)
    pages, current, page_no = [], [], 1
    for paragraph in doc.paragraphs:
        text = paragraph.text.strip()
        if text:
            current.append({
                'id': f'p{page_no:03d}-l{len(current)+1:02d}',
                'page': page_no,
                'text': text,
                'style': paragraph.style.name,
            })
        if paragraph._p.pPr is not None and paragraph._p.pPr.sectPr is not None:
            pages.append({'page': page_no, 'lines': current})
            page_no += 1
            current = []
    pages.append({'page': page_no, 'lines': current})
    return pages


def content_lines(page):
    lines = page['lines'][:]
    if lines and lines[0]['text'] == HEADER:
        lines = lines[1:]
    if lines and lines[-1]['text'] == str(page['page']):
        lines = lines[:-1]
    return lines


def public_line(line):
    return {key: line[key] for key in ('id', 'page', 'text')}


def section_kind(label):
    label = no_accents(label)
    if label.startswith('cach '):
        return 'method'
    return {'cong dung': 'uses', 'lieu dung': 'dosage', 'nhan xet': 'notes', 'kieng': 'notes'}.get(label, 'notes')


def structure_recipe(recipe, notes):
    ingredients, sections, prelude = [], [], []
    current_section = None
    for line in recipe['rawLines'][1:]:
        text = line['text']
        matched = SECTION.match(text)
        if matched:
            label, body = matched.groups()
            current_section = {
                'kind': section_kind(label),
                'label': label[0].upper() + label[1:],
                'text': body,
                'sourcePages': [line['page']],
                'lineIds': [line['id']],
            }
            sections.append(current_section)
        elif current_section is not None:
            current_section['text'] = plain(current_section['text'] + ' ' + text)
            current_section['sourcePages'] = sorted(set(current_section['sourcePages'] + [line['page']]))
            current_section['lineIds'].append(line['id'])
        else:
            # Ingredient lists occur before the first method/use/dosage section.
            if text.startswith('+') or '\t' in text:
                cells = text.split('\t')
                name = re.sub(r'^\+\s*', '', cells[0]).strip().rstrip(':;').strip()
                quantity = plain(' '.join(cells[1:])) if len(cells) > 1 else ''
                if not quantity:
                    inline_amount = re.fullmatch(r'(.*?)\s*[:;]\s*(\d[^\t]*)', name)
                    if inline_amount:
                        name, quantity = inline_amount.group(1).strip(), inline_amount.group(2).strip()
                if ingredients and not text.startswith('+') and ingredients[-1]['name'].count('(') > ingredients[-1]['name'].count(')'):
                    # One source ingredient wraps across p67–68 inside parentheses.
                    previous = ingredients[-1]
                    previous['name'] = plain(previous['name'] + ' ' + name)
                    previous['quantity'] = quantity
                    previous['sourceText'] += '\n' + text
                    previous['sourcePages'] = sorted(set(previous['sourcePages'] + [line['page']]))
                    previous['lineIds'].append(line['id'])
                    continue
                ingredients.append({
                    'name': name,
                    'quantity': quantity,
                    'sourceText': text,
                    'sourcePages': [line['page']],
                    'lineIds': [line['id']],
                })
            else:
                prelude.append(line)
    recipe['ingredients'] = ingredients
    recipe['sections'] = sections
    recipe['ingredientNotes'] = plain(' '.join(l['text'] for l in prelude))
    recipe['ingredientNoteLines'] = [public_line(line) for line in prelude]
    recipe['sourcePages'] = sorted({line['page'] for line in recipe['rawLines']})
    recipe['startPage'], recipe['endPage'] = recipe['sourcePages'][0], recipe['sourcePages'][-1]
    recipe['usageSummary'] = ' '.join(s['text'] for s in sections if s['kind'] == 'uses')
    recipe['sourceText'] = '\n'.join(line['text'] for line in recipe['rawLines'])
    recipe['searchText'] = plain(' '.join([recipe['categoryName'], recipe['subcategory'], recipe['sourceText']]))
    recipe['searchNormalized'] = no_accents(recipe['searchText'])
    recipe['rawLines'] = [public_line(line) for line in recipe['rawLines']]
    structured_ids = [recipe['rawLines'][0]['id']]
    structured_ids += [line_id for ingredient in ingredients for line_id in ingredient['lineIds']]
    structured_ids += [line_id for section in sections for line_id in section['lineIds']]
    structured_ids += [line['id'] for line in prelude]
    assert len(structured_ids) == len(set(structured_ids)) == len(recipe['rawLines']), recipe['id']
    assert set(structured_ids) == {line['id'] for line in recipe['rawLines']}, recipe['id']
    recipe['sourceNotes'] = []
    note_source = plain(recipe['sourceText'])
    if 'Ngày uống 8 - 10 chia 2 lần.' in note_source:
        recipe['sourceNotes'].append('Dòng liều dùng trong nguồn ghi “8 - 10” và không nêu đơn vị; bản tra cứu giữ nguyên cách ghi này.')
    if '1 đợt điều trị từ 10 - 5 thang.' in note_source:
        recipe['sourceNotes'].append('Dòng nguồn ghi “10 - 5 thang”; bản tra cứu giữ nguyên khoảng số này để đối chiếu với trang sách.')
    if prelude:
        notes['unstructuredPrelude'].append({'id': recipe['id'], 'lines': [public_line(l) for l in prelude]})
    if not ingredients:
        notes['recipesWithoutIngredientRows'].append(recipe['id'])
    for kind in ('method', 'uses', 'dosage'):
        if not any(s['kind'] == kind for s in sections):
            notes['missingSectionTypes'].append({'id': recipe['id'], 'kind': kind})
    return recipe


def build_book(path: Path):
    pages = read_pages(path)
    body = [line for page in pages if 5 <= page['page'] <= 133 for line in content_lines(page)]
    categories, subcategories, recipes = [], [], []
    assignments = {}
    category, subcategory, current = None, None, None
    category_counts = Counter()
    notes = {'unstructuredPrelude': [], 'recipesWithoutIngredientRows': [], 'missingSectionTypes': [], 'unassigned': []}
    idx = 0

    def own(lines, owner):
        for line in lines:
            if line['id'] in assignments:
                raise ValueError(f'Duplicate ownership of source line {line["id"]}')
            assignments[line['id']] = owner

    def flush():
        nonlocal current
        if current is not None:
            recipes.append(structure_recipe(current, notes))
            current = None

    while idx < len(body):
        line, text = body[idx], body[idx]['text']
        if text.startswith('Phần thứ'):
            flush()
            order, slug, name = PART_BY_PAGE[line['page']]
            heading_lines = body[idx:idx+3]
            assert len(heading_lines) == 3 and all(l['page'] == line['page'] for l in heading_lines)
            category = {
                'id': slug, 'name': name, 'title': plain(' '.join(l['text'] for l in heading_lines[1:])),
                'partTitle': text, 'order': order, 'startPage': line['page'],
                'sourceHeadingLines': [public_line(l) for l in heading_lines],
            }
            categories.append(category)
            subcategory = None
            own(heading_lines, 'category:' + slug)
            idx += 3
            continue
        sub_match = SUBHEAD.match(text)
        if sub_match or (text.isupper() and not text.startswith(('+', '-')) and current is None):
            flush()
            heading_lines = [line]
            j = idx+1
            while j < len(body) and body[j]['text'].isupper() and not SUBHEAD.match(body[j]['text']) and not RECIPE.match(body[j]['text']) and not body[j]['text'].startswith(('+', '-')):
                heading_lines.append(body[j]); j += 1
            title = plain(' '.join(l['text'] for l in heading_lines))
            clean_title = SUBHEAD.sub(lambda m: m.group(2), title)
            sub_count = sum(1 for s in subcategories if s['categoryId'] == category['id'])+1
            subcategory = {
                'id': f'{category["id"]}-s{sub_count:02d}',
                'categoryId': category['id'], 'title': title,
                'name': clean_title[0].upper()+clean_title[1:].lower(),
                'startPage': line['page'], 'order': sub_count,
                'sourceHeadingLines': [public_line(l) for l in heading_lines],
            }
            subcategories.append(subcategory)
            own(heading_lines, 'subcategory:' + subcategory['id'])
            idx = j
            continue
        recipe_match = RECIPE.match(text)
        if recipe_match:
            flush()
            category_counts[category['id']] += 1
            recipe_id = f'{category["id"]}-{category_counts[category["id"]]:03d}'
            current = {
                'id': recipe_id, 'ordinal': len(recipes)+1, 'categoryOrdinal': category_counts[category['id']],
                'number': int(recipe_match.group(1)),
                'title': text.lstrip('+ ').rstrip(':.').strip(),
                'headingText': text,
                'categoryId': category['id'], 'categoryName': category['name'],
                'subcategoryId': subcategory['id'] if subcategory else None,
                'subcategory': subcategory['name'] if subcategory else '',
                'rawLines': [line],
            }
            own([line], recipe_id)
        elif current is not None:
            current['rawLines'].append(line)
            own([line], current['id'])
        else:
            notes['unassigned'].append(public_line(line))
        idx += 1
    flush()
    for i, cat in enumerate(categories):
        cat['endPage'] = (categories[i+1]['startPage']-1) if i+1 < len(categories) else 133
        cat['recipeCount'] = category_counts[cat['id']]
        cat['subcategoryIds'] = [s['id'] for s in subcategories if s['categoryId'] == cat['id']]
    for sub in subcategories:
        subset = [r for r in recipes if r['subcategoryId'] == sub['id']]
        sub['recipeCount'] = len(subset)
        sub['endPage'] = max((r['endPage'] for r in subset), default=sub['startPage'])
    repeated = Counter((r['categoryId'],r['subcategoryId'],r['number']) for r in recipes)
    for recipe in recipes:
        if repeated[(recipe['categoryId'], recipe['subcategoryId'], recipe['number'])] > 1:
            recipe['sourceNotes'].append('Có hai bài liên tiếp cùng mang số 2 trong mục này ở bản gốc; hai nội dung được lưu riêng và giữ nguyên số thứ tự.')
    notes['repeatedNumbers'] = [{'categoryId': key[0], 'subcategoryId': key[1], 'number': key[2], 'count': count} for key,count in repeated.items() if count>1]
    notes['sourceQuirksRetained'] = [
        {'page': 21, 'text': 'Ngày uống 8 - 10 chia 2 lần.', 'note': 'Đơn vị không được nêu trong dòng nguồn.'},
        {'page': 25, 'note': 'Hai bài thuốc liên tiếp cùng mang số 2 trong phần viêm gan mãn.'},
        {'page': 82, 'note': 'Số thứ tự chuyển từ bài 2 sang bài 6 theo bản gốc.'},
        {'page': 116, 'note': 'Tiêu đề gốc ghi Bài thuốc 13, không có chữ số.'},
        {'page': 121, 'text': '1 đợt điều trị từ 10 - 5 thang.', 'note': 'Khoảng số được giữ đúng dòng nguồn.'},
    ]
    intro_lines = [l for p in pages if p['page'] in (3,4) for l in content_lines(p)]
    introduction = {
        'title': plain(' '.join(l['text'] for l in intro_lines[:3])),
        'text': plain(' '.join(l['text'] for l in intro_lines[3:])),
        'sourcePages': [3,4], 'rawLines': [public_line(l) for l in intro_lines],
    }
    source_metadata = {
        'title': 'Những bài thuốc quý trong dân gian',
        'creditedOrganization': 'Bệnh viện Y học cổ truyền Thanh Hóa',
        'publisher': 'Nhà xuất bản Thanh Niên',
        'imprintText': '\n'.join(l['text'] for l in content_lines(pages[135])),
        'imprintPage': 136,
        'tableOfContents': [{ 'page': p['page'], 'lines': [public_line(l) for l in content_lines(p)]} for p in pages if p['page'] in (134,135)],
    }
    report = {
        'sourcePages': len(pages), 'bodyLineCount': len(body), 'assignedLineCount': len(assignments),
        'recipeCount': len(recipes), 'categoryCount': len(categories), 'subcategoryCount': len(subcategories),
        'recipeBodyLineCount': sum(len(r['rawLines']) for r in recipes),
        'ingredientRows': sum(len(r['ingredients']) for r in recipes),
        'sectionCount': sum(len(r['sections']) for r in recipes),
        **notes,
    }
    assert len(assignments) == len(body), notes['unassigned']
    assert not notes['unassigned']
    assert len({r['id'] for r in recipes}) == len(recipes)
    expected_lines = {l['id']:l['text'] for l in body}
    reconstructed = {}
    for r in recipes:
        reconstructed.update({l['id']: l['text'] for l in r['rawLines']})
    for item in categories+subcategories:
        reconstructed.update({l['id']:l['text'] for l in item['sourceHeadingLines']})
    assert reconstructed == expected_lines, 'Lossless raw source coverage failed'
    data = {
        'meta': {
            'schemaVersion': 1, 'title': 'Những bài thuốc quý trong dân gian',
            'sourceFilename': path.name, 'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'sourcePages': len(pages), 'recipeCount': len(recipes),
            'categoryCount': len(categories), 'subcategoryCount': len(subcategories),
            'language': 'vi', 'contentVersion': '1.0.0',
            'description': 'Tra cứu nội dung cuốn sách theo nhóm, bài thuốc và tên vị thuốc.',
            'sourceNote': 'Nội dung được chép lại từ tài liệu nguồn; cách gọi, số thứ tự và số lượng được giữ theo sách.',
        },
        'categories': categories, 'subcategories': subcategories, 'recipes': recipes,
        'introduction': introduction, 'sourceMetadata': source_metadata,
    }
    return data, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    data, report = build_book(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if not isinstance(v,list)},ensure_ascii=False))
    print('Unstructured prelude:', json.dumps(report['unstructuredPrelude'],ensure_ascii=False))
    print('Missing section types:',json.dumps(report['missingSectionTypes'],ensure_ascii=False))
    print('Repeated numbering:',json.dumps(report['repeatedNumbers'],ensure_ascii=False))


if __name__ == '__main__':
    main()
