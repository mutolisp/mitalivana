# Mitalivana Privacy Policy

*[正體中文版](PRIVACY.md)*

**v0.2 | 2026-09-26** (adds Team sync)

Mitalivana is an offline-first field tool for biodiversity surveys. This policy explains what the app stores on your device, the circumstances under which data leaves your device, and how you can delete it.

---

## 1. Summary

1. There are no accounts. The only server the developer operates is the Team sync relay, which receives only data encrypted on your phone and cannot read it (see section 4); apart from that, the app does not send your survey data to any host operated by the developer.
2. There is no analytics, tracking, advertising or crash reporting: the app bundles no analytics or advertising SDK, and collects no device identifiers, usage behaviour or location for analytics purposes.
3. Nothing is uploaded automatically. Every outbound transfer happens only when you press a button yourself (see section 4).
4. The developer does not obtain the content of your data. Your survey records exist only on your device, in the third-party accounts you choose to send them to (your own iNaturalist account, your own Google Drive), and as ciphertext held on the relay during Team sync.

---

## 2. What the app stores on your device

The following stays in the app's local database and file area and is never sent anywhere automatically:

- **Survey records**: quick checklists, plot surveys (including layers and subplots) and collection records — species lists, counts / cover values, remarks, timestamps
- **Location data**: the GPS coordinates and accuracy of each record, transect tracks, and the sites and areas you create on the map
- **Media**: photos (kept in your device photo library; the database stores only a reference) and audio recordings (kept in the app's own directory)
- **People**: surveyor / collector names you enter, project names and descriptions
- **Usage**: search history, favourite lists, identification-key progress, preferences
- **Credentials**: iNaturalist / Google tokens, GBIF account and password (optional)

The app also ships read-only databases such as the Taiwan species checklist (TaiCOL). Those are reference data and contain no personal data of yours.

### Why each permission is used

- **Location (while using the app only)**: to obtain coordinates for observations and survey records, to record transect tracks, and to position you on the map. The app uses no background-location capability.
- **Camera / Photos**: to take and pick species photos. Photos taken in the app get EXIF / IPTC fields describing the species written into them and are saved back to your photo library.
- **Microphone**: to record species sounds (bird song, frog calls) or your own spoken notes.

---

## 3. How credentials and tokens are stored

- **iNaturalist**: a WebView lets you log in on iNaturalist's own page; the app retrieves only a token valid for 24 hours and never sees or stores your password. The token is kept in the iOS Keychain / Android Keystore and does not enter backup files.
- **Google Drive**: authorisation uses the device flow, with the `drive.file` scope only, which means the app can see only the files it created itself and cannot see anything else in your Drive. The refresh token is likewise kept in the Keychain / Keystore and does not enter backups.
- **Team sync key**: the team key created when you create or join a team is kept in the Keychain / Keystore (this device only, available when unlocked) and never goes into a backup. It is the team's key, and it is also in the QR code and invitation code the lead shows.
- **Cloudflare API token** (only for “Use my own Cloudflare”): used during the deployment only; never stored or backed up. The server admin token the deployment creates is kept in the Keychain / Keystore.
- **GBIF**: downloading a country species pack requires your GBIF account. Whether it is saved is your choice; if you save it, it is stored as plain-text JSON in the app's own directory (inside the sandbox) and deliberately not in the database, so it cannot be carried into a backup file or a shared export. Clear it in settings if you do not wish to keep it.

---

## 4. When data leaves your device

**Uploading to iNaturalist**: this is the only feature of the app that sends your location, photos and audio together, so please read what is sent carefully:

- **Location**: the latitude, longitude and positional accuracy (m) of each observation. The app always sends the real coordinates you recorded, together with the geoprivacy setting you chose (open / obscured / private) — that setting determines how iNaturalist displays the locality publicly, while the actual coordinates still reach iNaturalist's servers. See iNaturalist's own documentation for the details.
- **Photos**: every photo attached to the record, uploaded in order as the original file. The photos themselves may carry EXIF data such as capture time and GPS.
- **Audio**: every audio clip attached to the record (m4a).
- **Other**: the observation identifier (UUID), scientific name, observation time (including time zone), remarks and tags.

Once uploaded, this data resides in your own iNaturalist account, and how publicly it appears is determined by the geoprivacy you chose together with that site's settings; its subsequent handling is governed by iNaturalist's terms and privacy policy and lies outside this app's control. You can edit or delete those observations on the iNaturalist website at any time (deleting a record in the app does not delete an observation that has already been uploaded).

**Backing up to Google Drive**, that is, when you press backup: a zipped snapshot of the user database is uploaded (all the local data in section 2, without the original photo files); the photo backup is a separate zip. The files are placed in a folder the app creates in your own Google Drive, keeping at most five of them.

**Downloading a country species pack (GBIF)**: a download request is sent to GBIF under your GBIF account (including the email address used for notification). GBIF retains a record of that download request in its system.

**Team sync**: the app connects only when you press Sync, Fetch the team's records, Cloud usage and similar buttons.

- **What is sent**: the record's content (species, quantities, coordinates, surveyor names, notes; not photos or recordings) and the name you set for yourself in the team, encrypted on the phone with the team key (XChaCha20-Poly1305) before it is sent.
- **What the server sees**: the team code, hashed record and device codes, file sizes, upload times and the connecting IP address. It cannot read the records, and the codes do not reveal which project, plot or summit they are.
- **Default server**: operated by the developer on Cloudflare (`sync.mitalivana.org`, Cloudflare Workers + R2). Data is deleted automatically 90 days after its last update, and the team lead can delete all of a team's cloud data at any time. To limit abuse the server counts team creations per day by a hash of the IP address; those counters are deleted after two days. As the infrastructure provider, Cloudflare's handling is governed by Cloudflare's privacy policy.
- **Self-hosted server**: if a team uses a server one member deployed ("Use my own Cloudflare"), the data sits in that member's Cloudflare account and is that member's responsibility; the content is ciphertext there too.
- **Who can read it**: anyone holding the team's invitation code or QR code can read and change the team's data, so give it only to teammates.

**Asking "which species occur in this area"**: the area you draw on the map (polygon coordinates) is sent to GBIF / iNaturalist to obtain a species list for it. In other words, the place you ask about becomes known to those services.

**Map tiles**: when you browse online maps, tiles are requested from map services — Apple Maps on iOS, Google Maps on Android, and additionally Taiwan's National Land Surveying and Mapping Center (<https://wmts.nlsc.gov.tw>), Academia Sinica historical maps (<https://gis.sinica.edu.tw>) and the vector basemap (<https://map.mitalivana.org>). Those services see the map location you are browsing and your IP address in the request. Once an offline map has been downloaded, that area is read from local files instead.

**Connectivity detection**: when a service call fails, the app sends a body-less HEAD request to `api.inaturalist.org` or `api.gbif.org` to determine whether the cause is "no network" or "that service is down". None of your data is transmitted.

**External links and exports**: species pages provide external links to TaiCOL, GBIF, iNaturalist, Wikispecies, NCBI, IPNI, POWO and others; tapping one connects your browser to that site. Who receives an exported file (yml / CSV / document [DOCX / ODT] / Darwin Core Archive / backup) is entirely up to you through the system share sheet. Please note that exported photos may carry GPS EXIF data, and that checklist and Darwin Core files also contain coordinates and surveyor names.

Each of the services above has its own privacy policy, and their handling of data lies outside this app's control.

Apart from the cases above, your location, photos and audio remain on your device only; under no circumstances does the developer receive them.

---

## 5. Other people's personal data

If you enter the names of other surveyors or collectors in your records, those names are stored on your device and are sent along with exported files and cloud backups. Please make sure you have an appropriate basis for handling such data.

Uploads to iNaturalist do not include the surveyor field (an observation is always attributed to the account you are logged in with); such names reach iNaturalist only if you typed them into a record's remarks or tags yourself.

---

## 6. Your choices and how to delete data

- **Delete individual items**: delete records, projects, favourite lists, photos or audio clips inside the app.
- **Clear search history**: Settings → "Clear search history" removes every stored search string.
- **Clear all data**: Settings → "Clear all data" deletes every record, project and setting (the bundled species checklists are kept).
- **Disconnect third-party services**: unlinking iNaturalist in settings also logs out the server-side session; unlinking Google Drive revokes the grant with Google. Both also delete the token held on the device.
- **Team sync**: Leave team deletes the team key and sync state from this phone; the team lead can use Delete cloud data to remove all of the team's data from the server at once, otherwise it is deleted 90 days after its last update.
- **Uninstall the app**: deleting the app also removes the local database, audio recordings and the files the app created; photos held in the system photo library are not deleted.
- **Data already uploaded**: for observations already sent to iNaturalist and backups already placed in Google Drive, please delete them in those services directly.

---

## 7. Children

This app is a field survey tool. It is not designed for children and does not collect children's personal data.

---

## 8. Changes to this policy, and contact

If a change in functionality affects how data is handled, this policy will be updated accordingly, along with the effective date at the top.

Contact: Cheng-Tao Lin, [contact@mitalivana.org](mailto:contact@mitalivana.org)
