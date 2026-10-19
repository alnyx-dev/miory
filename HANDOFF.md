# MIORY — контекст для продолжения работы

Документ для «холодного старта» в новой сессии: что за проект, что уже
сделано, где лежат ключи и адреса, какие решения приняты и почему, что
делать дальше и в каком порядке.

---

## 1. Что это

Токен на Solana (Anchor 0.32.2 + Token-2022) с программным контролем над
эмиссией, комиссией-перевода, которая сгорает, и on-chain метаданными.
Репозиторий: https://github.com/alnyx-dev/miory (приватный, ветка `main`,
CI зелёный).

Ключевое свойство: **mint, freeze и fee authority — это PDA программы**, а не
кошелёк. Никто вне программы не может выпустить токен, заморозить его или
вывести удержанные комиссии.

---

## 2. Текущее состояние (проверено на devnet)

| что | значение |
|---|---|
| Program ID | `8Zpfnt8KTaawG541AvpXxoYKo2dxd8Yk7U6k5Eu62HDF` (devnet; на мейннете — тот же ключ) |
| Mint (devnet) | `AWpKSeyPmFAs91y3MTbJ1jRS4zKfBKbAv3uKci6JEKFA` (Token-2022, 9 decimals) |
| Расширения mint'а | `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata` — набор, который AMM принимают при создании пула |
| authority PDA | `8xtf1cgCga1nZNQYyyQrsLDgfUM4pvghNXPtWR8LAhT` (mint / freeze / fee authority) |
| config PDA | `DrCKUzyZbhW2cPicrqFApJozKQ4dHsLE9y9x7PhJddY7` |
| denylist PDA | `Fmu7oXxkhBuYctYo4aMnuugLwyZRC5TS4KetcGxg95FR` |
| Комиссия | 0 bps на старте (поднимается через `set_transfer_fee`, в силе через 2 эпохи) |
| Метаданные | name `MIORY`, symbol `MIORY`, uri `https://miory.example/metadata.json` |
| Supply на devnet | 100 000 000 (начеканено тестом) |

### Ключи и кошельки

| что | где | комментарий |
|---|---|---|
| Ключpair программы | `F:\MIORY\target\deploy\miory-keypair.json` | **в git не лежит** (в `.gitignore`), это upgrade authority программы. Бэкап офлайн! |
| Ключpair старой программы | **потерян** | Старый program id `FmoRzYQcTNoFsWFXYwaqNCjsmN4gHjufp4kGTJXJrAx5` брошен: его mint нёс `TransferHook`, а расширение из mint'а не удаляется. Программу нельзя ни обновить, ни закрыть → ~3.05 devnet SOL застряли. |
| Кошелёк деплоя | `C:\Users\alex\.config\solana\id.json` = `AEcay6mpCFZDWrd5X33fJWuNveC98JYeskKBAsc7oiPg` | На devnet 0.61 SOL. Сейчас он же админ протокола — для мейннета так быть не должно. |
| Секреты в GitHub | `PROGRAM_KEYPAIR`, `DEPLOY_WALLET`, `ANCHOR_PROVIDER_URL`, `ANCHOR_WALLET` + переменная `MIORY_URI` | Для мейннета `PROGRAM_KEYPAIR` из секретов убрать. |

---

## 3. Тулчейн (уже установлен на этой машине)

| компонент | где | версия |
|---|---|---|
| Anchor CLI | `C:\Users\alex\.cargo\bin\anchor.exe` (в PATH) | 0.32.2 |
| Solana CLI + `cargo-build-sbf` | `C:\Users\alex\.local\solana\bin` (в PATH) | 4.3.2 |
| Node / npm | системные | 24.x |
| Solana CLI в WSL2 | `~/.local/solana/solana-release/bin` (внутри WSL) | 4.3.2 |

Anchor CLI на Windows ставится **готовым бинарником** из релизов
(`anchor-0.32.2-x86_64-pc-windows-msvc.exe`): сборка из исходников через
`cargo install anchor-cli` падает на `openssl-sys` (в системе нет OpenSSL).

---

## 4. Команды

```bash
# в F:\MIORY
npm install
anchor build                 # BPF-сборка + IDL (target/deploy/miory.so, target/idl/miory.json)
npm run lint                 # cargo fmt --check + cargo clippy -D warnings
npm run deploy:devnet        # anchor deploy --provider.cluster devnet
npm run deploy:mint          # init → mint → перевод → collect_fees на devnet

# локальные тесты (нужен поднятый валидатор)
wsl -d Ubuntu -- bash /mnt/f/MIORY/scripts/dev/validator.sh     # в фоне
wsl -d Ubuntu -- bash /mnt/f/MIORY/scripts/dev/deploy-local.sh    # деплой программы
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
npm run test:integration
```

IDL можно собрать и без Anchor CLI: `bash scripts/build-idl.sh` (тот же путь,
что использует `anchor idl build`).

---

## 5. Архитектура и принятые решения

### Сжигание комиссии — нативный `TransferFeeConfig`

Токен-программа сама удерживает `fee = amount * bps / 10_000` (потолок
`max_fee`) на каждом переводе, деньги лежат на аккаунте получателя как
*withheld fees*. Вывести их может только fee authority (PDA программы) →
инструкция `collect_fees` (permissionless) выводит их в vault и сжигает
(mint authority — тоже PDA).

Почему не burn внутри transfer hook: токен-программа передаёт в хук аккаунты
**только на чтение** → хук не может изменить баланс получателя (проверено:
рантайм даёт `writable privilege escalated`). PermanentDelegate это обошёл бы,
но выдал бы программе право изъять токены у любого держателя.

### Transfer hook убран из mint'а — сознательно

Хук требует, чтобы клиент передал его аккаунты-состояния (токен-программа
берёт их из `ExtraAccountMetaList` mint'а). Роутер DEX'а про них не знает →
любой перевод через обычный роутер падал бы с `AccountNotEnoughKeys`. Плюс AMM
не создают пул для mint'а с расширением `TransferHook` (whitelist Raydium:
`TransferFeeConfig, MetadataPointer, TokenMetadata`, `InterestBearingConfig`,
`ScaledUiAmount`).

Реализация хука осталась в истории git: `git show 4b0968d:programs/miory/src/lib.rs`.
Если понадобится отдельный mint с хуком — поднимается отдельной программой.

Цена решения: **нет глобального kill switch** и **нет лимита на размер
перевода** (без хука нечем enforce'ить). Вместо этого — точечная заморозка.

### Политика — через freeze authority

`freeze_account` / `thaw_account` (freeze authority = PDA программы) и
`set_denylist` + `sync_denylist` (список заблокированных адресов применяется
заморозкой их аккаунтов; `sync_denylist` размораживает снятых с списка).

### Передача прав админа — двухшаговая

`propose_admin(new_admin)` текущим админом → `accept_admin()` новым админом.
Опечатка в адресе не блокирует протокол навсегда.

### Метаданные — расширение `TokenMetadata` внутри самого mint'а

Токен-программа разрешает хранить метаданные только в аккаунте mint'а
(`Initialize` требует metadata == mint). Расширение переменной длины → mint
растёт, и **ренту за новый размер платит инициализатор** (перевод ламports
на mint перед записью), иначе аккаунт перестаёт быть rent-exempt.

`MetadataPointer` указывает на сам mint.

---

## 6. Структура репозитория

```
programs/miory/src/
  lib.rs        инструкции, контексты аккаунтов, хелперы
  state.rs      Config / Authority / Denylist
  errors.rs     кастомные ошибки
  constants.rs  seeds и лимиты
scripts/
  miory-client.ts        общие хелперы (PDAs, парсер метаданных, TransferChecked)
  deploy-and-mint.ts     клиент: init → mint → transfer → collect_fees
  build-idl.sh           генерация IDL без Anchor CLI
  extract-idl.js         парсер вывода cargo-теста в IDL
  dev/validator.sh       WSL-валидатор
  dev/deploy-local.sh    деплой на локальный валидатор из WSL
tests/miory.test.ts      11 интеграционных тестов
.github/workflows/
  ci.yml                 lint + test + build
  deploy-devnet.yml      ручной деплой на devnet
```

Инструкции программы (13): `initialize`, `mint_to`, `burn`, `collect_fees`,
`set_transfer_fee`, `set_denylist`, `sync_denylist`, `set_metadata`,
`freeze_account`, `thaw_account`, `propose_admin`, `accept_admin`.

---

## 7. Подводные камни (не повторять)

**Окружение**

- Валидатор Solana **не работает на Windows**: падает при распаковке
  genesis-архива (нужны права на symlink). Решение — WSL2 (скрипты в
  `scripts/dev/`).
- Windows-CLI → WSL-валидатор **не тянет деплой 400+ КБ программы**
  («Data writes to account failed: Max retries exceeded»). Деплоить из WSL
  (`scripts/dev/deploy-local.sh`).
- `anchor test` поднимает локальный валидатор **только** при
  `cluster = "localnet"` в Anchor.toml; при `devnet` он деплоит на devnet
  (и падает на «insufficient funds»). Поэтому в Anchor.toml кластер
  `localnet`, а devnet-деплой идёт с `--provider.cluster devnet`.
- `anchor deploy` **не собирает** программу — нужен отдельный `anchor build`.
- `coral-xyz/anchor` — это CLI-репозиторий, а не GitHub Action (`action.yml`
  нет). Тулчейн в раннере ставится скриптом `scripts/ci/install-toolchain.sh`.
- В CI `concurrency: cancel-in-progress` — пуш во время прогона отменяет
  текущий прогон.
- Публичные devnet-фаунеты ограничены по IP (429). RPC `api.devnet.solana.com`
  тоже отдаёт 429 на частые запросы — клиент сам повторяет попытки.
- `solana program close` требует `--bypass-warning`: закрытый program id
  восстановить нельзя никогда.

**Протокол Token-2022**

- Расширения инициализируются **до** `initialize_mint2`: токен-программа
  проверяет, что выделенный размер mint'а **точно** совпадает с суммой
  размеров инициализированных расширений. Лишнего места быть не может.
- `TransferHook` аккаунты всегда read-only → хук не может жечь/списать.
- `TokenMetadata` — переменной длины → растёт аккаунт → нужна доплата ренты.
- TLV-заголовок записи — **4 байта**: `type: u16` + `len: u16` (в JS-SDK
  `TYPE_SIZE = 2`).
- JS-SDK `getAccount(...)` для Token-2022 требует 4-й аргумент
  `programId`, иначе `TokenInvalidAccountOwnerError`.
- `TransferFeeConfig`: новая ставка вступает в силу через **две эпохи**
  (защита от rug pull в конце эпохи). Ставку поднимать только после
  появления ликвидности — часть платформ может отвалиться
  («they may begin to fail if you turn fees on»).

**Anchor**

- `Signer<'info>` нельзя использовать для PDA: в внешней инструкции PDA не
  подписант. Подпись PDA — через `invoke_signed` + сиды.
- Инструкции с `remaining_accounts` требуют явного лайфтайма:
  `fn x<'info>(ctx: Context<'_, '_, '_, 'info, X<'info>)` — иначе конфликт
  инвариантности `AccountInfo`.
- `#[account(init, ...)]` c `seeds`/`bump` и `owner = <token program>` — так
  создаётся mint (владелец — токен-программа, а не наша программа).
- Denylist хранится в `Vec` (в куче): inline-массив на 64 адреса копировался
  бы на стек при каждой десериализации и ломал лимит кадра BPF в 4 KB.
- `declare_id!`/`Anchor.toml`/IDL должны совпадать с ключpair программы.

---

## 8. Что делать дальше (по порядку)

1. **Пул на Raydium devnet** — финальная проверка «торгуемо». Скрипты готовы
   (`scripts/dev/raydium-pool.ts` — CPMM, `scripts/dev/raydium-clmm.ts` — CLMM),
   но на devnet **нет программы новой CPMM** (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
   — аккаунт есть, но owner = system program, не executable), поэтому пул
   создаётся через CLMM (`DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` — задеплоена).
   CLMM-пул требует ~3 SOL: рента аккаунта пула, тик-массива и позиции.
   Нужен SOL на деплой-кошельке — публичные devnet-фаунеты не выдают его с
   текущего IP (rate limit), на кошельке сейчас 0.46 SOL.
2. **Multisig-админ** — создать Squads-кошелёк 2/3 (отдельный кошелёк, не
   деплой-кошелёк) и передать ему права:
   `propose_admin(treasury)` → `accept_admin()` от treasury.
3. **Ротация ключей** — программный ключpair убрать из секретов GitHub, держать
   офлайн; для CI при необходимости — отдельный ключpair без права апгрейда.
4. **Аудит** — diff «вариант A» против ревизии с хуком (коммит `4b0968d`)
   удобно отдать одним коммитом; основной риск — `collect_fees` (вывод
   удержанных комиссий) и `sync_denylist` (заморозка по списку).
5. **Мейннет-деплой** — тот же program id и ключpair (на мейннете PDA mint'а
   свободен), нужен SOL (~3.05 ренты program-аккаунта) и топ-комиссия.
6. **Ликвидность** — не наша часть: пул MIORY/SOL, наполнение, дальше Jupiter
   подхватывает токен автоматически. Скрипты из п.1 показывают, как это
   делается технически.
7. **Опционально** — отдельный mint с transfer hook (реализация в истории
   git), если понадобится on-chain политика без заморозки.

### Как создать пул (когда будет SOL)

```bash
# на devnet, ~3 SOL на кошельке
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx tsx scripts/dev/raydium-clmm.ts
```

Особенности, которые стоит помнить:

- wSOL-аккаунт владельца создаётся **вручную** (classic token program,
  `InitializeAccount`): associated token program v7 инициализирует аккаунты
  только через Token-2022, а нативный mint принадлежит classic-программе;
- для Token-2022 mint'а в Raydium нужен путь `SwapV2` (CLMM) — обычный
  `Swap` не поддерживает расширения;
- SDK v2 (`@raydium-io/raydium-sdk-v2`, 0.2.74-alpha) отдаёт адрес пула в
  `result.builder.returns.address.poolId` (у CPMM) — типы в .d.ts для этого
  кривые, поэтому в скриптах используются `as any`.

---

## 9. Полезные ссылки

- Raydium: поддержка Token-2022 и transfer fee —
  <https://docs.raydium.io/algorithms/token-2022-transfer-fees>
- Raydium: whitelist расширений при создании пула —
  <https://docs.raydium.io/reference/token-2022-support>
- Jupiter: токены с transfer fee и лимитные/DCA-ордера —
  <https://docs.jup.ag/user-docs/trade/spot/token-page>
- Solana: расширение Transfer Hook и его ограничения —
  <https://solana.com/docs/tokens/extensions/transfer-hook>
- Solana: расширение Transfer Fee —
  <https://solana.com/docs/tokens/extensions/transfer-fee>
