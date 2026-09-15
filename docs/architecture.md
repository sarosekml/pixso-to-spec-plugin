# Архитектура

## Runtime-поток

```text
Pixso selectionchange
        │
        ▼
code.js: фильтр FRAME ───────────────► ui.html: состояние кнопки
        │
        │ request-export (md/html)
        ▼
code.js: snapshot выбранных фреймов
        ├─ имя
        ├─ URL: origin + fileKey + page-id + item-id
        ├─ поиск TEXT[name=description]
        └─ HTML only: frame.exportAsync(JPG)
                 │
                 ▼ export-row (по одному фрейму)
ui.html: экранирование и сборка таблицы
        ├─ Markdown: ссылка без изображения
        └─ HTML: ссылка + JPEG data URI
                 │
                 ▼
           один Blob download
```

## Почему две части

Sandbox Pixso имеет доступ к документу, выделению, `fileKey` и `FrameNode.exportAsync`, но не к DOM и браузерному скачиванию. UI iframe имеет DOM, `Blob` и `URL.createObjectURL`, но не имеет прямого доступа к Pixso document API. Поэтому sandbox передаёт UI нормализованные строки и JPEG data URI сообщениями.

Строки HTML отправляются по одной, а не одним общим объектом. Это снижает пиковый размер сообщения при экспорте нескольких больших фреймов и позволяет обновлять прогресс после каждого кадра.

## Ссылка на фрейм

Ссылка собирается в виде:

```text
{pixso.origin}/app/editor/{pixso.fileKey}
  ?showQuickFrame=true
  &icon_type=1
  &page-id={ownerPage.id}
  &item-id={frame.id}
```

`page-id` и `item-id` URL-кодируются. Если Pixso не предоставляет `fileKey`, экспорт завершается явной ошибкой: файл без валидной ссылки не создаётся.

## Поиск description

Используется поиск в ширину по дочерним узлам фрейма. Совпадением считается только `TEXT`-узел, у которого `name.trim().toLowerCase() === "description"`. Возвращается первое совпадение в визуальном порядке дерева. Текст не обрезается: переносы строк сохраняются и безопасно преобразуются при генерации таблицы.

## Сборка

`scripts/build-plugin.mjs` копирует runtime-файлы в `dist/pixso-to-spec` и встраивает PNG-иконку в HTML как data URI. Это необходимо из-за null-origin iframe в Pixso 2.0, где относительная загрузка ресурсов может отличаться между dev и packaged режимами.
