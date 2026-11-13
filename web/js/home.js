import { fmt } from './grid.js';

const meta = await fetch('data/cities.json').then(r => r.json());
const signed = v => v == null ? '—' : (v > 0 ? '+' : '') + fmt(v, 1);

// Картки міст: мініатюра денного шару, ΔT удень і вночі, посилання на карту
const box = document.getElementById('cityCards');
for (const c of meta.cities) {
  const art = c.article || {}, dayOk = c.dt_day_comparable !== false;
  const day = art.dT_day ?? c.stats.mean_dt_day, night = art.dT_night_ecostress ?? c.stats.mean_dt_night;   // числа статті
  const a = document.createElement('a');
  a.className = 'city-card';
  a.href = `map.html#city=${c.id}&layer=dt_day`;
  a.innerHTML = `
    <span class="thumb"><img src="data/${c.id}/dt_day.png" alt="" loading="lazy"></span>
    <span class="nm">${c.name}</span>
    <span class="nums">
      <span><i class="dot day"></i>удень <b>${signed(day)} °C${dayOk ? '' : '*'}</b></span>
      <span><i class="dot night"></i>уночі <b>${signed(night)} °C</b></span>
    </span>`;
  if (!dayOk) a.title = '* Заміський еталон такий самий гарячий, як забудова, — у статті денна ΔT Дніпра не входить до порівняння міст';
  box.append(a);
}
if (meta.cities.some(c => c.dt_day_comparable === false)) {
  const fn = document.createElement('p');
  fn.className = 'footnote';
  fn.textContent = '* ' + meta.cities.filter(c => c.dt_day_comparable === false).map(c => c.name).join(', ') +
    ': заміський еталон (степові поля) такий самий гарячий, як забудова, тому денна ΔT близька до нуля; у статті вона не входить до денного порівняння міст.';
  box.after(fn);
}

// Велика ілюстрація: місто з найсильнішим денним островом
const top = meta.cities.filter(c => c.dt_day_comparable !== false)
  .sort((a, b) => (b.article?.dT_day ?? b.stats.mean_dt_day) - (a.article?.dT_day ?? a.stats.mean_dt_day))[0];
if (top) {
  document.getElementById('heroImg').src = `data/${top.id}/dt_day.png`;
  document.getElementById('heroCap').textContent = `${top.name}: перегрів поверхні вдень`;
}
