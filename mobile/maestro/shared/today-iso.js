// Today's date as `YYYY-MM-DD` (the plan's date format), for `today.yaml`.
// Maestro runs this on the host, so the host and the emulator must agree on
// the local date (an emulator takes the host's time zone by default).
// No padStart: keep to what every Maestro JS engine has.
var now = new Date();
function two(n) {
  return n < 10 ? '0' + n : '' + n;
}
output.todayIso = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate());
