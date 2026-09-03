import shutil
import sqlite3

import soundfile as sf

c = sqlite3.connect("file:D:/MusicDatasets/db/corpus_index.sqlite?mode=ro", uri=True)
for t, n in c.execute("select type,name from sqlite_master where type in ('table','view')"):
    try:
        cnt = c.execute("select count(*) from [%s]" % n).fetchone()[0]
    except Exception as e:
        cnt = str(e)
    print(t, n, cnt)
print("libsndfile", sf.__libsndfile_version__)
print("formats", sorted(sf.available_formats().keys()))
print("ffmpeg", shutil.which("ffmpeg"))
