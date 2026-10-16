# Office fixtures

`report.docx`, `deck.pptx`, `book.xlsx` are small source files; `report/`, `deck/` and
`book/` hold the convert service's `to=html` output for each (`document.html`, `media/`,
`document.<odt|odp|ods>`), produced with the `apps/convert` image (Alpine 3.22
LibreOffice). Adapter tests read these outputs and need no LibreOffice.

`report.docx` was made from `report.source.fodt` (footnote, endnote, comment, nested list,
image, link to `deck.pptx`, two H1 chapters). `deck.pptx` (python-pptx): title + outline
levels + speaker notes, a column chart, a slide without title (text box + image), a table.
`book.xlsx` (openpyxl): sheet `Daten` with dates and a merged cell, `Summe` with a formula
on `Daten`, an empty sheet `Leer`.

To refresh: run the image, `curl --data-binary @report.docx "localhost:8080/convert?to=html&name=report.docx" -o r.zip` and unzip into `report/`.
