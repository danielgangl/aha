# Zielbild — aha

Kurzfassung der gemeinsamen Richtung. Lebende Notiz, keine Spec.

## Für wen

Senior Engineers, die AI-generierte PRs so schnell wie möglich durchpflügen müssen — mit **so wenig mental strain wie möglich** und dem **besten Review-Outcome**.

## Das Problem (in meinen Worten)

- „Der größte Teil ist gerade **Mental Friction**, weil ich extrem viel Work parallelisieren und überblicken und verstehen muss, was wo passiert."
- Über mehrere PRs hinweg: nicht mehr „Fuck, welchen Work habe ich jetzt wo und wie zusammen", sondern „ein Ding, wo ich meine Pull Requests sehe, und dann kann ich dort reinspringen".

## Was aha ist (der Reframe)

aha ist **weder** eine AI-Summary (kann CodeRabbit) **noch** ein Diff-Viewer (kann GitHub), sondern eine **Lese-Umgebung, die nach den kognitiven Fundamentals gebaut ist**: Orientierung vor Detail, progressive Disclosure, Zustand aus dem Kopf rausnehmen (was ist wo, was hat sich geändert, was war meine Entscheidung).

Der Wert sitzt auf **zwei** Achsen — beide zusammen sind der Moat:

1. **Das AI-Verständnis / der Inhalt** — die Essenz. „Theoretisch kann ich jede Information mit KI hier generieren." Die jetzigen Sachen (Noise, Decisions, Reading Order, Change-Note) sind erste Versuche, noch nicht final überlegt.
2. **Die Aufbereitung** — „wie ich damit als Mensch visuell arbeiten kann". Ein 8.000-Wörter-Block mit aller Info → struggle. Nice aufbereitet → low mental friction.

> **In GitHub könnten wir das nicht so aufbereiten — das ist genau der Punkt.** Die Information ist die Essenz, aber es geht extrem darum, *wie* sie aufbereitet ist. Deshalb ist die Aufbereitung hier kein austauschbarer Renderer.

## Vitamin → Painkiller

- Status heute: gut genug, dass **ich lieber hier drin reviewe als in GitHub**. Overview/High-Level sind aber noch nicht perfekt → aktuell noch eher Vitamin.
- Ziel: gemeinsam **vom Vitamin zum Painkiller** machen.
- **Disziplin-Regel (was Vitamin von Painkiller trennt):** Jedes UI-/High-Level-Element muss auf **eine konkrete Entscheidung mappen, die es leichter macht** — oder **etwas aus meinem Kopf rausnehmen**. Sonst fliegt es raus. Keine „random hilfreich wirkenden" Features.

## Das Erfolgsziel

- **10x schneller einen einzelnen PR merge-reif** bekommen.
- **10x schneller über mehrere PRs hinweg** (Folge davon).

## Die Aufteilung (in meinen Worten)

- **~60–70 %: generelles Verständnis / High-Level** — alles, was *nicht* Code-Lesen ist: was hängt wo wie zusammen, das Mental Model.
- **~30 %: Code scrollen** — die schlechten Junior-/AI-Code-Sachen finden, entfernen, clean machen.
- **Code sehen bleibt essenziell.** Die AI macht viele Sachen noch nicht gut genug (oder ich habe noch keinen Weg gefunden, wie sie's gut macht). Der Burn-down **ersetzt das Lesen nicht — er priorisiert und führt zum Code.**

## Der Hebel: Attention-Burn-down

Die Werkzeug-Einheit ändern: von **„Dateien, die ich lesen muss"** → **„Entscheidungen, die ich treffen muss"**.
(Dateien/Zeilen skalieren mit der Diff-Größe, die AI brutal aufbläht. Entscheidungen skalieren mit der echten Komplexität — viel kleiner.)

> Was davon schon existiert: Decision-Cards + Risk + Triage (accept/flag/block) + ein Triaged-Count. Der **Delta** = nach Risk sortieren · offen vs. erledigt (Liste schrumpft auf 0) · „PR fertig = Liste leer" statt „Files gelesen" · Decisions als **Spine** · Re-Review-Repopulation · Dashboard-Rollup. Kein Rebuild.

- **Pro PR:** High Level = kurze, priorisierte Worklist (Risk / Decision / Assumption). Jedes Item: 1-Satz-Claim · warum es zählt · Sprung zum exakten Code · Aktion (ok / flag / muss geändert werden). Rest = Noise, eingeklappt. **„PR fertig" = Liste leer**, nicht „alle Dateien gescrollt".
- **Re-Review:** Worklist füllt sich nur mit „was hat sich seit meinem letzten Blick geändert" → Re-Review ist auch ein Burn-down, kein Re-Read. (Das Change-Konzept gehört hierher.)
- **Über mehrere PRs (Dashboard als Cockpit):** sortiert nach „am nächsten an einer Entscheidung / N offene Items / seit-Ansicht geändert / wartet auf mich" → immer der **eine** nächste höchstwertige Move. Pro Karte **„N offen" prominent, x/y Files klein daneben** (beides, nicht nur Files).

## Woran wir Painkiller messen (an meinen eigenen echten PRs)

- War „Worklist leer + kurzer Blick" ≈ **confident merge**?
- Wie viele Dateien habe ich **wirklich geöffnet** vs. wie viele hat der Diff?
- Time-to-first-decision.

## Später (Ideen)

- **Feedback-Loop:** meine eigenen Kommentare/Notizen beim Reviewen sammeln → Muster finden → daraus **Default-Prompts** ableiten, damit die AI genau die Sachen besser macht, wo sie heute noch schwächelt. Die jetzigen Enrichment-Sachen (Noise, Decisions, Reading Order, Change-Note) sind erste Versuche — der Loop macht sie systematisch besser.

## Bewusst (noch) nicht

- Kein GitHub-Write-back / keine Approvals — die *tiefe* Review-Umgebung ist das Produkt; GitHub kann das Substrat nicht hosten. (GitHub später evtl. als Distributions-Köder für den Inhalt, nicht als Ort des Reviews.)
- AI-Init per Klick und der „Update"-Button bleiben vorerst der Copy-Prompt-an-Agent-Flow.
