"""Writes fixtures/excel/legacy.xls, a small Excel 97-2003 (BIFF8) workbook.

The Rust fixture generator can't write the legacy .xls format, so this one
file is made with xlwt (pip install xlwt==1.3.0):

    python scripts/make_xls.py
"""

import datetime
import pathlib

import xlwt

out = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "excel" / "legacy.xls"

book = xlwt.Workbook(encoding="utf-8")
date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD")

sheet = book.add_sheet("Inventory")
for col, name in enumerate(["sku", "item", "stock", "price", "received", "active"]):
    sheet.write(0, col, name)
rows = [
    (1001, "Widget", 12, 9.5, datetime.date(2024, 1, 15), True),
    (1002, "Gädget", 0, 100.0, datetime.date(2023, 12, 31), False),
    (1003, "Sprocket", 250, 1.25, datetime.date(2024, 2, 29), True),
]
for r, row in enumerate(rows, start=1):
    for c, value in enumerate(row):
        if isinstance(value, datetime.date):
            sheet.write(r, c, value, date_style)
        else:
            sheet.write(r, c, value)

second = book.add_sheet("Empty")  # a sheet with no data
book.save(str(out))
print(f"wrote {out}")
