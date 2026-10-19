# MIORY

Кастомный SPL-токен на Solana (Anchor 0.32 + Token-2022): mint под контролем
программы, комиссия с перевода, которая сгорает, и кастомный transfer hook.

```
F:\MIORY
├── Anchor.toml                 # конфиг Anchor (кластер, program id, скрипты)
├── Cargo.toml                  # workspace
├── package.json / tsconfig.json
├── programs/miory/             # программа на Rust (Anchor)
│   ├── src/lib.rs              # инструкции, контексты аккаунтов, transfer hook
│   ├── src/state.rs            # Config / Authority / Denylist
│   ├── src/errors.rs           # кастомные ошибки
│   └── src/constants.rs        # seeds и лимиты протокола
├── scripts/
│   ├── miory-client.ts         # общие хелперы (PDA, инструкция TransferChecked)
│   ├── deploy-and-mint.ts      # деплой/инициализация/чеканка/перевод/сжигание
│   └── build-idl.sh             # генерация IDL без Anchor CLI
└── tests/miory.test.ts         # интеграционные тесты (mocha + chai)
```

## Архитектура

### Модель прав

| Право | Кто владеет | Как реализовано |
|---|---|---|
| Mint authority | программа | PDA `authority` (`seeds = ["authority"]`), подписывает CPI чеканки |
| Freeze authority | программа | та же PDA, `mint::freeze_authority` |
| Fee authority | программа | та же PDA, `TransferFeeConfig` |
| Admin | кошелёк | `config.admin`, проверка `has_one = admin` во всех админ-инструкциях |

PDA `authority` — программный аккаунт, поэтому подписать от его имени может
только сама программа. Ни один внешний аккаунт не может выпустить токен,
заморозить его или вывести удержанные комиссии.

### Сжигание комиссии

Комиссия реализована нативным расширением Token-2022 `TransferFeeConfig`:

1. токен-программа сама удерживает `fee = amount * bps / 10_000` (с потолком
   `max_fee`) на каждом переводе; сумма лежит на аккаунте получателя как
   *withheld fees* и не является его расходуемым балансом;
2. перевести её может только fee authority — наша PDA;
3. `collect_fees` выводит удержанные комиссии в vault протокола и сжигает их
   (mint authority — тоже наша PDA). Инструкция **permissionless**: краб может
   вызвать кто угодно, выигрывают от этого держатели токена.

Итог: supply токена уменьшается на каждом переводе, а экономический supply
(то, что реально можно потратить) уменьшается мгновенно.

Комиссия стартует с нуля: расширение установлено сразу (mint проходит
проверку расширений у AMM), а ставка поднимается позже через
`set_transfer_fee`, когда появится ликвидность. Новая ставка вступает в силу
через две эпохи — это защита Token-2022 от rug pull в конце эпохи.

Почему не `PermanentDelegate` и не burn внутри хука: токен-программа передаёт
в хук аккаунты только на чтение, а permanent delegate выдал бы программе право
изъять токены у любого держателя.

### Политика: заморозка вместо transfer hook

Mint **не несёт** расширение `TransferHook`, и это осознанное решение:

* хуку нужны его аккаунты-состояния, а их передаёт клиент (токен-программа
  берёт их из `ExtraAccountMetaList` mint'а). Роутер DEX'а про них не знает и
  не передаёт → любой перевод через обычный роутер падал бы с
  `AccountNotEnoughKeys`;
* AMM отказываются создавать пул для mint'а с расширением `TransferHook`
  (у Raydium в перечень допустимых расширений входят `TransferFeeConfig`,
  `MetadataPointer`, `TokenMetadata`, `InterestBearingConfig`, `ScaledUiAmount`).

Поэтому политика обеспечивается freeze authority, который и так у mint'а:

* `freeze_account` / `thaw_account` — заморозка/разморозка аккаунта
  держателя (freeze authority = PDA программы, CPI подписывает она);
* `set_denylist` + `sync_denylist` — список заблокированных адресов и его
  применение: аккаунты заблокированных адресов замораживаются, а снятые с
  списка — размораживаются. Токены заблокированного адреса не могут уйти.

Цена этого решения: глобального kill switch нет (с хуком он был бы), а
лимит на размер перевода тоже не enforce'ится. Вместо этого — точечная
заморозка, которая работает мгновенно.

Реализация хука (с extra-аккаунтами и проверками политики) осталась в истории
git: `git show 4b0968d:programs/miory/src/lib.rs` — если понадобится mint с
хуком, его можно поднять отдельной программой и отдельным mint'ом.

## PDA

| PDA | seeds | назначение |
|---|---|---|
| `authority` | `["authority"]` | mint / freeze / fee / hook authority |
| `config` | `["config"]` | параметры протокола |
| `denylist` | `["denylist"]` | заблокированные адреса |
| `mint` | `["mint"]` | сам mint (Token-2022) |

## Инструкции

| Инструкция | Кто может | Назначение |
|---|---|---|
| `initialize(args)` | admin | создаёт mint, конфиг, denylist, пишет on-chain метаданные |
| `mint_to(amount)` | admin | чеканка в ATA получателя (подписывает PDA) |
| `burn(amount)` | владелец | сжигание своих токенов |
| `collect_fees()` | anyone | вывод удержанных комиссий в vault и их сжигание |
| `set_transfer_fee(bps, max_fee)` | admin | новая комиссия (вступает в силу через 2 эпохи) |
| `set_denylist(addresses)` | admin | список заблокированных адресов (до 64) |
| `sync_denylist()` | admin | применяет список: замораживает/размораживает аккаунты |
| `set_metadata(name, symbol, uri)` | admin | обновление on-chain метаданных |
| `freeze_account()` / `thaw_account()` | admin | заморозка/разморозка аккаунта держателя |
| `propose_admin(new_admin)` | admin | первый шаг передачи прав админа |
| `accept_admin()` | pending admin | второй шаг передачи прав админа |

Передача прав админа двухшаговая: `propose_admin` от текущего админа и
`accept_admin` от нового. Опечатка в адресе не приводит к потере контроля —
новый админ должен подтвердить передачу своим ключом. Так админом может стать
SPL-multisig или treasury Squads: адрес мультисига — это обычный pubkey, а
подпись мультисига проходит проверку `Signer` в Anchor.

Админские операции, меняющие деньги, уже имеют задержку: комиссия
активируется через две эпохи (механизм самого Token-2022), а pause/denylist
применяются сразу — pause это emergency-контроль, и задерживать его нельзя.

### Сайт и метаданные

- `site/index.html` — лендинг: показывает живой supply токена с публичного RPC.
- `site/metadata.json` — метаданные в стандартном формате (Metaplex).
- `site/logo.svg` — знак токена.
- `.github/workflows/pages.yml` — публикация статики на GitHub Pages.

On-chain URI токена указывает на `https://alnyx-dev.github.io/miory/metadata.json`
(обновлён инструкцией `set_metadata`, tx
`5VH71tdNmc98QznFd9KwJmFr8uarK5nfxZt751EM79mi9Qj1odjthLXEhYrrjKYnjobScsGtN2VK4nqH7WujGwS7`).

**GitHub Pages на бесплатном плане работает только для публичных репозиториев.**
Чтобы сайт поднялся, сделайте репозиторий публичным (или используйте платный
план) и перезапустите воркфлоу `Pages`. Пока репозиторий приватный, метаданные
доступны напрямую в репозитории: `site/metadata.json`.

## Зависимости и аудит

`cargo audit` (RustSec Advisory DB) — **0 уязвимостей** ✓. Проверка запускается
в CI на каждом PR (`rustsec/audit-check`).

Информационные предупреждения (не уязвимости, только в дереве зависимостей
Solana/Anchor, в BPF-бинарник программы они не попадают): `bincode`
RUSTSEC-2025-0141 и `libsecp256k1` RUSTSEC-2025-0161 — «не поддерживаются»
(авторы прекратили development), `rand` 0.7.3 RUSTSEC-2026-0097 — unsound при
кастомном логгере с `thread_rng` (в нашем коде не используется).

## Инварианты протокола

Раздел для аудита: что программа может, кто распоряжается правами и что
зафиксировано на уровне протокола.

### Кто что может

| Действие | Кто может | Чем обеспечено |
|---|---|---|
| Выпустить токен | только программа | mint authority = PDA `authority`; вне программы подписать выпуск нельзя |
| Сменить mint/freeze/fee authority | никто | authority = PDA, у программы нет инструкции её смены |
| Вывести удержанные комиссии | только программа | fee authority = PDA; единственный путь — `collect_fees`, который сжигает их, а не переводит |
| Удержание комиссии | токен-программа | `TransferFeeConfig`, ставка ≤ 5% (`MAX_TRANSFER_FEE_BPS`), потолок `max_fee`, новая ставка через 2 эпохи |
| Сжечь токены держателя | только сам держатель | инструкция `burn` требует подпись владельца аккаунта |
| Заморозить аккаунт | админ | freeze authority = PDA; `freeze_account`/`thaw_account`, `sync_denylist` |
| Обновить метаданные | админ | `set_metadata`, update authority = PDA |
| Сменить админа | текущий админ + новый | двухшаговая передача `propose_admin` → `accept_admin` |
| Сжечь комиссию из vault | кто угодно | `collect_fees` permissionless, но сжигает, а не выводит |

### Что зафиксировано

- **Supply уменьшается только сжиганием.** Эмиссия — единственный путь роста,
  комиссия всегда уходит в сжигание, а не на баланс владельца.
- **Комиссия ограничена** ставкой (≤ 5%) и абсолютным потолком `max_fee`;
  изменение ставки вступает в силу через две эпохи (защита Token-2022 от rug
  pull в конце эпохи).
- **Деньги никогда не уходят на кошелёк.** Удержанные комиссии живут на
  аккаунтах получателей как withheld fees, вывести их может только fee
  authority (PDA), и единственная инструкция, которая это делает, сжигает их.
- **Заморозка обратима**: `thaw_account` и `sync_denylist` размораживают
  аккаунты, снятые с denylist.
- **Передача админа без потери контроля**: опечатка в адресе не блокирует
  протокол — новый админ должен подтвердить передачу своим ключом.
- **Программа не может двигать токены держателей**: единственное исключение —
  заморозка (блокирует переводы, но не уничтожает токены).

### Что стоит проверить аудитору (и что осознанно не сделано)

- `collect_fees` — вывод удержанных комиссий из чужих аккаунтов: корректно
  ли выбираются источники и нельзя ли вывести что-то лишнее.
- `sync_denylist` — заморозка/разморозка по списку: нельзя ли заморозить
  чужой аккаунт без основания.
- `set_transfer_fee` — потолок ставки и двухэпохная задержка соблюдаются.
- **Эмиссия не ограничена сверху.** Админ может выпустить сколько угодно
  токенов (mint authority — PDA, и инструкция `mint_to` не проверяет потолок).
  Если нужен hard cap, его надо добавить в конфиг и проверять в `mint_to` —
  это осознанно не сделано, потому что лимит эмиссии обычно фиксируют на
  уровне экономики токена, а не в смарт-контракте.
- **Комиссия с перевода начисляется получателю** (экономика нативного
  `TransferFeeConfig`): отправитель платит полную сумму, получатель получает
  сумму за вычетом комиссии.

## Он-чейн метаданные

Метаданные токена (name / symbol / uri) лежат в расширении `TokenMetadata`
самого mint'а — токен-программа разрешает хранить метаданные только в
аккаунте mint'а, а указатель `MetadataPointer` в mint'е обязателен.

Две особенности реализации:

* `TokenMetadata` — расширение переменной длины, поэтому при его записи
  токен-программа **увеличивает аккаунт mint'а**. Ренту за новый размер
  платит инициализатор: перед записью метаданных на mint переводится
  недостающая ламбда, иначе аккаунт перестал бы быть rent-exempt и мог бы
  быть закрыт на границе эпохи.
* Метаданные пишутся инструкцией `TokenMetadata::Initialize` (а при обновлении
  — тремя `UpdateField`), подписью authority-PDA программы. Обновление
  метаданных меняет длину расширения, поэтому `set_metadata` тоже
  докуменсирует mint до нужного размера.

Лимиты: name ≤ 32, symbol ≤ 10, uri ≤ 200 байт. При обновлении на более
короткие значения лишняя ламбда остаётся на mint'е.

## Состояние

| | |
|---|---|
| Program ID | `8Zpfnt8KTaawG541AvpXxoYKo2dxd8Yk7U6k5Eu62HDF` (devnet, mейннет — тот же ключ) |
| Mint | `AWpKSeyPmFAs91y3MTbJ1jRS4zKfBKbAv3uKci6JEKFA` (Token-2022, 9 decimals) |
| Расширения mint'а | `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata` — набор, который AMM принимают при создании пула |
| Mint / freeze authority | PDA программы `8xtf1cgCga1nZNQYyyQrsLDgfUM4pvghNXPtWR8LAhT` |
| Комиссия | 0 bps на старте, поднимается через `set_transfer_fee` (в силе через 2 эпохи) |
| Метаданные | name `MIORY`, symbol `MIORY`, uri `https://miory.example/metadata.json` |

Программа с transfer hook осталась в истории git (`4b0968d`) — её program id
`FmoRzYQcTNoFsWFXYwaqNCjsmN4gHjufp4kGTJXJrAx5` больше не используется, а
его ключpair утерян вместе с ability обновлять/закрывать ту программу.

## Сборка и запуск

Тулчейн (уже установлен на этой машине):

| Компонент | Путь | Версия |
|---|---|---|
| Anchor CLI | `C:\Users\alex\.cargo\bin\anchor.exe` | 0.32.2 |
| Solana CLI + `cargo-build-sbf` | `C:\Users\alex\.local\solana\bin` (в PATH) | 4.3.2 |

Anchor CLI на Windows ставится готовым бинарником из релизов
(`anchor-0.32.2-x86_64-pc-windows-msvc.exe`): сборка из исходников через
`cargo install anchor-cli` падает на `openssl-sys` — в системе нет OpenSSL.

```bash
npm install
anchor build                 # target/deploy/miory.so + target/idl/miory.json
anchor test                  # поднимает локальный валидатор и гоняет тесты
```

Тесты (`tests/miory.test.ts`):

| Тест | Что проверяет |
|---|---|
| creates the mint with the program controlled authorities | decimals, supply, mint/freeze authority = PDA |
| mints to the admin | чеканка в ATA |
| withholds the transfer fee and runs the hook | хук вызван, комиссия удержана токен-программой |
| burns the withheld fees | `collect_fees` уменьшает supply |
| blocks the transfers when the protocol is paused | kill switch |
| schedules a new fee for the next epochs | `set_transfer_fee` обновляет расширение mint |
| freezes and thaws a holder | freeze authority = PDA, инструкции заморозки |
| hands the admin role over in two steps | `propose_admin` + `accept_admin`, старый админ отрезан |
| stores the metadata on chain | `TokenMetadata` в mint'е, update authority = PDA |
| updates the metadata on chain | `set_metadata` переписывает name/symbol/uri |
| freezes the accounts of the denylisted addresses | `sync_denylist` замораживает аккаунты заблокированных |

Программа и IDL собираются и обычным cargo (если Anchor CLI недоступен):

```bash
cargo build-sbf                                    # target/deploy/miory.so
bash scripts/build-idl.sh                          # target/idl/miory.json
```

Деплой и полный флоу на devnet.

Кошелёк деплоя: `C:\Users\alex\.config\solana\id.json`
(`AEcay6mpCFZDWrd5X33fJWuNveC98JYeskKBAsc7oiPg`) — **сберечь его, это
деплой-ключ программы**.

Параметры метаданных при инициализации берутся из переменных окружения:
`MIORY_NAME` (по умолчанию `MIORY`), `MIORY_SYMBOL`, `MIORY_URI`.

```bash
# 1. пополнить devnet (3.05 SOL уходит в ренту program-аккаунта, лучше 4)
solana airdrop 2 --url devnet --keypair ~/.config/solana/id.json

# 2. задеплоить программу
# кластер в Anchor.toml по умолчанию localnet (только он поднимает локальный
# валидатор для `anchor test`), поэтому devnet указывается явно
npm run deploy:devnet        # = anchor deploy --provider.cluster devnet

# 3. инициализация + чеканка + перевод через хук + сжигание комиссии
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npm run deploy:mint
```

Публичные devnet-фаунеты ограничивают запросы по IP (и
`api.devnet.solana.com`, и прокси-провайдеры), поэтому пополнение кошелька
иногда приходится делать через web-фаунет с логином.

`scripts/deploy-and-mint.ts` идёт по цепочке: инициализация → чеканка →
перевод через хук (печатает удержанную комиссию) → `collect_fees` (печатает,
сколько supply сгорело).

### Локальный валидатор на Windows

Валидатор Solana официально не работает на Windows: падает при распаковке
genesis-архива (нужны права на создание symlink). Рабочий вариант — WSL2 с
Linux-сборкой `solana-test-validator`, BPF-бинарник платформенно-независим:

```bash
# в WSL2
export PATH="$HOME/.local/solana/solana-release/bin:$PATH"
solana-test-validator --reset --log --ledger ~/miory-ledger \
  --bpf-program 8Zpfnt8KTaawG541AvpXxoYKo2dxd8Yk7U6k5Eu62HDF \
  /mnt/f/MIORY/target/deploy/miory.so
```

Флаг `--log` обязателен на Windows: без него валидатор пытается создать
symlink лог-файла и падает.

Тесты против этого валидатора:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=<кошелёк> \
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/miory.test.ts
```

## Безопасность

* Все административные инструкции защищены `has_one = admin` + `Signer`.
* Передача прав админа двухшаговая, поэтому опечатка в адресе не блокирует
  протокол навсегда.
* Mint authority, freeze authority и fee authority — только PDA программы,
  подпись внешним аккаунтом невозможна.
* Суммы считаются через `checked_*`, в профиле release включён
  `overflow-checks = true`.
* `collect_fees` — permissionless, но тратит только комиссию, удержанную
  токен-программой, и подписывает её вывод PDA fee authority.
* Denylist хранится в `Vec` (в куче), а не inline-массивом: массив на 64
  адреса копировался бы на стек при каждой десериализации и ломал лимит
  кадра BPF в 4 KB.

## Ограничения

* Комиссия сжигается краном `collect_fees`: до его вызова комиссия лежит на
  аккаунте получателя как withheld fees (не тратится, но и не сожжена).
* Новая комиссия вступает в силу через две эпохи: Token-2022 специально
  активирует fee двух эпох вперёд, чтобы исключить rug pull в конце эпохи.
  Значение в `config` отражает *запрошенную* комиссию, активная может временно
  отличаться.
* `max_fee` — абсолютный потолок комиссии, `transfer_fee_bps` ограничен 5%
  жёстким лимитом программы (`MAX_TRANSFER_FEE_BPS`).
* Список denylist ограничен 64 адресами (ёмкость аккаунта выдаётся при
  создании).
* Метаданные ограничены по длине: name ≤ 32, symbol ≤ 10, uri ≤ 200 байт.

## CI

`.github/workflows/ci.yml` — на каждый push в `main` и на каждый PR:

| job | что делает |
|---|---|
| `lint` | `cargo fmt --check` + `cargo clippy -- -D warnings` |
| `test` | `cargo test --workspace` + `anchor test` (поднимает локальный валидатор, деплоит программу и гоняет TS-тесты) |
| `build` | `anchor build` + выкладка IDL артефактом |

Тулчейн в раннере ставится скриптом `scripts/ci/install-toolchain.sh`: репозиторий
Anchor — это CLI, а не GitHub Action, поэтому Solana CLI ставится официальным
установщиком, а Anchor CLI — готовым бинарником релиза.

Кластер в `Anchor.toml` — `localnet`: только при нём `anchor test` поднимает
локальный валидатор, иначе CLI деплоит на кластер из конфига. Devnet-деплой
поэтому указывается явно: `anchor deploy --provider.cluster devnet`.

Локально то же самое: `npm run lint`, `npm run test:integration` (нужен
поднятый валидатор), `npm run build`.

`.github/workflows/deploy-devnet.yml` — ручной деплой на devnet
(`workflow_dispatch`). Секреты:

| secret | что это |
|---|---|
| `PROGRAM_KEYPAIR` | программный ключpair (base64), upgrade authority программы |
| `DEPLOY_WALLET` | кошелёк деплоя (base64) |
| `ANCHOR_PROVIDER_URL` | RPC devnet |
| `ANCHOR_WALLET` | путь к кошельку в раннере |

Переменная `MIORY_URI` (repo variable) — URI метаданных, который уходит в
`initialize`.

## Замечания по окружению

* Валидатор Solana официально не работает на Windows. Для локального прогона
  используйте WSL2 с Linux-сборкой `solana-test-validator` — BPF-бинарник
  платформенно-независим, его достаточно собрать один раз на Windows.
* `solana-test-validator` на Windows падает ещё и на создании symlink
  лог-файла: запускайте его с флагом `--log` (без `--quiet`).
