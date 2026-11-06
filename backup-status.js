// Backup dates stay on this device. A browser download request cannot confirm the file was saved.
export function backupIndicator(element, key) {
  function refresh() {
    try {
      const raw = localStorage.getItem(key);
      const t = raw ? Number(raw) : 0;
      if (!Number.isFinite(t) || t <= 0 || t > Date.now()) { element.textContent = '전체 백업을 아직 요청하지 않았어요.'; return; }
      const date = new Date(t).toLocaleDateString('ko-KR');
      const old = Date.now() - t >= 14 * 24 * 60 * 60 * 1000;
      element.textContent = `마지막 전체 백업 다운로드 요청: ${date}. ` + (old ? '최근 기록을 다시 백업하세요.' : '파일이 저장됐는지 확인하세요.');
    } catch { element.textContent = '백업 날짜를 이 기기에 저장할 수 없어요.'; }
  }
  function mark() { try { localStorage.setItem(key, String(Date.now())); } catch {} refresh(); }
  refresh();
  return { mark, refresh };
}
