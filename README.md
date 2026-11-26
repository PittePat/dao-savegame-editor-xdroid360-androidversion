# Dragon Age: Origins Savegame Editor für XDroid360 – Android-App

Android-Version des Desktop-Editors. Der komplette Editor-Kern (GFF-4-Bibliothek, Fähigkeiten-Katalog,
ZIP-/CRC-Logik) ist **unverändert aus dem Python-Projekt** übernommen und läuft per
[Chaquopy](https://chaquo.com/chaquopy/) direkt auf dem Handy. Statt wxPython gibt es eine Touch-Oberfläche
(WebView, `app/src/main/assets/www`).

## Funktionen

* **ZIP öffnen** (XDroid360-Export): bei mehreren Spielständen Auswahl mit Charakter, Gebiet, Spielzeit, Level
* **Übersicht:** Geld, max. Gewicht, Spielzeit, Zustimmung der Gefährten
* **Items:** Rucksack, Plot-Gegenstände, Party-Lager, Party-Truhen – Anzahl, „Unendlich“, ResRef, Aus-Liste-wählen
  (8000+ bekannte Gegenstände), Duplizieren, Verschieben, Löschen, alle Felder bearbeiten
* **Charakter:** nicht ausgegebene Punkte, Zauber/Talente/Fertigkeiten/Spezialisierungen (Haken = gelernt),
  alle Werte (Basis/Modifikator/Aktuell/Regeneration), Eigenschaften hinzufügen (z. B. Resistenzen)
* **Gebiete:** Truhen, Händler, Kreaturen einzelner Gebiete
* **Sprache:** Deutsch und Englisch. Standard ist die Gerätesprache (Deutsch → Deutsch, alles andere → Englisch), umstellbar unter *Übersicht → Sprache* bzw. auf dem Startbildschirm. Weitere Sprachen: Tabelle in `assets/www/i18n.js` ergänzen. Gegenstands- und Fähigkeitsnamen stammen aus den Spieldaten und bleiben englisch.
* **Bedienung:** Die Scroll-Position bleibt beim Zurückgehen (Container, Tabs, Listen) erhalten.
* **Speichern:** schreibt in eine ZIP-Kopie der App und aktualisiert die `.x`-CRC32-Prüfsumme; danach
  „Als neue ZIP speichern“ (empfohlen, das Original bleibt unberührt) oder „Original überschreiben“.
  Die gespeicherte ZIP lässt sich direkt wieder in XDroid360 importieren.

## APK bauen

**Variante A – GitHub (ohne Android Studio):**
1. Ordner als Repository auf GitHub hochladen.
2. Reiter *Actions* → *Build APK* läuft automatisch (oder „Run workflow“).
3. Fertige `app-debug.apk` unter *Artifacts* herunterladen, auf dem Handy installieren
   (Installation aus unbekannten Quellen erlauben). Mit einem Tag `vX.Y.Z` wird sie zusätzlich an ein Release gehängt.

**Variante B – Android Studio:** Ordner öffnen, Gradle-Sync abwarten, *Run* oder *Build → Build APK(s)*.
Auf der Kommandozeile: `./gradlew assembleDebug` (JDK 17, Android SDK 34, Python 3.12 auf dem Rechner;
Ergebnis: `app/build/outputs/apk/debug/app-debug.apk`).

## Entwickeln / Testen ohne Handy

```bash
python3 -I tests/test_bridge.py     # Öffnen, Bearbeiten, Speichern auf einem synthetischen Spielstand
python3 -I tests/dev_server.py      # Oberfläche im Desktop-Browser (http://127.0.0.1:8765), echte Python-Logik dahinter
```

## Aufbau

```
app/src/main/python/     bridge.py (JSON-Schnittstelle) + gff4/, abilities.py, savezip.py (Original-Kern)
app/src/main/assets/www/ index.html, app.css, app.js (Touch-Oberfläche)
app/src/main/java/…/MainActivity.kt   WebView, Dateiauswahl (Storage Access Framework), Brücke zu Python
```

## Hinweise

* Nur Dragon Age: Origins (GFF V4.0), keine einzelnen `.das`-Dateien – nur XDroid360-ZIP-Exporte.
* Die App fragt keine Berechtigungen an; Dateien kommen über den Android-Dateiauswahldialog.
* Vor dem Bearbeiten Sicherungskopie des Spielstands anlegen. Ob hinzugefügte Fähigkeiten oder geänderte Items
  im Spiel in jedem Fall wirken, ist – wie beim Desktop-Editor – nicht für alle Fälle geprüft.
* Der Kern wurde mit einem synthetischen Spielstand getestet, nicht mit einem echten Savegame auf dem Gerät.
