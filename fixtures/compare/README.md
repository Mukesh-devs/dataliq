# Compare fixtures

`orders_v1.csv` → `orders_v2.csv`, compared by `id`. Known differences:

| id | what | why |
| --- | --- | --- |
| 1 | same | `qty` is a number in v1 and text in v2 (`n/a` on id 3): `3` = `3` as text |
| 2 | changed `price` | 0.25 → 0.30 |
| 3 | changed `qty` | 100 → `n/a` |
| 4 | removed | |
| 5 (1st) | same | duplicate key: matched by order of appearance |
| 5 (2nd) | changed `note` | `dup` → `updated` |
| 5 (3rd) | added | only v2 has a third `id = 5` |
| 6 | changed `note` | empty → `new note` |
| 7 | added | |

Totals: 2 added, 1 removed, 4 changed, 2 the same; 2 rows of v1 and 3 of v2
share a key.
