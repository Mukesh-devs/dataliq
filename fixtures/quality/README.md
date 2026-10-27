# Quality fixture

`messy.csv` (22 rows, made by a small script) has these known problems:

| Column | Problem | Rows |
| --- | --- | --- |
| `name` | spaces at the start or end (ids 3, 7, 12) | 3 |
| `amount` | numbers stored as text, two values aren't (`n/a`, `12,50 EUR`) | 2 |
| `signup` | dates mostly as `2024-01-31`, three as `04/01/2024` (ids 4, 9, 16) | 3 |
| `score` | one value far outside the rest (`99999`, id 10; the others are 40–60) | 1 |
| `note` | empty in 18 of 22 rows | 18 |
| (all) | rows 21 and 22 are exact copies of rows 2 and 6 | 2 |

The trim, change-type and remove-duplicates fixes leave the date formats, the
empty notes and the outlier, which have no automatic fix.
