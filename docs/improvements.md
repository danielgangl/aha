# Improvements

- wie funktioniert die UI bei changed-viewed stuff genau, was sind die UX flows, wo helfen sie den human reviewers usern und wo behindern sie und wo könnten sie 10x helfen?
- Test/Confidence Pass: Nur: welche Tests beweisen was; welche Testlücken sind relevant; keine allgemeinen Entscheidungen. Possible additional mode somehow.
- High Level cards dinger nach risk sortieren.
- Echten globalen aha CLI install/linken: Prompt-Fallback ist gefixt, aber der Literal-Command `aha ...` funktioniert weiterhin nur, wenn es im PATH liegt.
- High-Level IA vereinfachen: High Level bleibt nur Orientierung (`mentalModelDelta`, `systemMap`, `modelDeltas`, `flows`); alles Bewertbare wird ein gemeinsames `Review Focus` / `Review Checks` Modell mit klaren Action-Typen wie `verify`, `inspect`, `decide`, `test-gap`, damit Punkte nicht zwischen `assumptions`, `hotspots` und `decisions` duplizieren.
- `risk` type inline ai notes.
- File level note should be a mini summary: wenn im Diff visuell viele Änderungen sind, aber funktional nur eine kleine Bedingung angepasst wurde oder sich genau ein Behaviour geändert hat, soll man das vorab wissen und Noise selbst ignorieren können.
