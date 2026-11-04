"""Regenerate REQUIREMENTS.pdf from its Markdown source using disposable ReportLab tooling.

Run from any directory: PYTHONPATH=/tmp/wte75-pdf-tooling python3 docs/build_requirements.py
ReportLab is a documentation tool, not an application dependency.
"""

import re
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle


def inline(text):
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r"<font name='Body'>\1</font>", text)
    return re.sub(r"\[([^]]+)\]\(([^)]+)\)", r'<link href="\2">\1</link>', text)


def build():
    root = Path(__file__).resolve().parent
    fonts = Path('/usr/share/fonts/truetype/dejavu')
    pdfmetrics.registerFont(TTFont('Body', str(fonts / 'DejaVuSans.ttf')))
    pdfmetrics.registerFont(TTFont('BodyBold', str(fonts / 'DejaVuSans-Bold.ttf')))
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('BodyText75', fontName='Body', fontSize=9, leading=13,
                              spaceAfter=6, alignment=TA_LEFT))
    styles.add(ParagraphStyle('Cell75', parent=styles['BodyText75'], fontSize=8, leading=11,
                              spaceAfter=0))
    for heading in ('Title', 'Heading1', 'Heading2'):
        styles[heading].fontName = 'BodyBold'
    document = SimpleDocTemplate(str(root / 'REQUIREMENTS.pdf'), pagesize=A4,
                                  rightMargin=42, leftMargin=42, topMargin=42,
                                  bottomMargin=42, title='What to eat! Requirements v1.8',
                                  author='Juan Castro')
    story = []
    lines = (root / 'REQUIREMENTS.md').read_text().splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if not line:
            continue
        if line.startswith('|'):
            rows = []
            while True:
                cells = [cell.strip() for cell in line.strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                    rows.append([Paragraph(inline(cell), styles['Cell75']) for cell in cells])
                if index >= len(lines) or not lines[index].strip().startswith('|'):
                    break
                line = lines[index].strip()
                index += 1
            width = document.width
            widths = ([width * .1, width * .81, width * .09]
                      if len(rows[0]) == 3 else [width * .25, width * .75])
            table = LongTable(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
            table.setStyle(TableStyle([
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')),
                ('GRID', (0, 0), (-1, -1), .3, colors.HexColor('#bbbbbb')),
                ('LEFTPADDING', (0, 0), (-1, -1), 6),
                ('RIGHTPADDING', (0, 0), (-1, -1), 6),
                ('TOPPADDING', (0, 0), (-1, -1), 5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ]))
            story.extend([table, Spacer(1, 9)])
        elif line.startswith('#'):
            level = len(line) - len(line.lstrip('#'))
            style = 'Title' if level == 1 else 'Heading1' if level == 2 else 'Heading2'
            story.append(Paragraph(inline(line.lstrip('#').strip()), styles[style]))
        else:
            story.append(Paragraph(inline(line), styles['BodyText75']))

    def footer(canvas, doc):
        canvas.setFont('Body', 8)
        canvas.drawRightString(A4[0] - 42, .35 * inch, f'What to eat! | v1.8 | {doc.page}')

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f'Generated REQUIREMENTS.pdf from {len(lines)} Markdown lines.')


if __name__ == '__main__':
    build()
