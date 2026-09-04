# Bundled reference-audio tools

QC Control's optional YouTube reference-audio tool invokes these unmodified
command-line programs as separate processes:

- yt-dlp 2026.08.19 (`UNLICENSE`): https://github.com/yt-dlp/yt-dlp
- Deno 2.9.6 (MIT): https://github.com/denoland/deno
- FFmpeg 8.1 LGPL build: https://github.com/BtbN/FFmpeg-Builds

Their respective copyright notices, licenses, and corresponding source are
available from the linked upstream projects. QC Control does not link against
these programs. The tool accepts only public YouTube URLs, requires an explicit
user rights confirmation, downloads a maximum 120-second audio excerpt, and
deletes the temporary local file after it has been attached to the model request.
