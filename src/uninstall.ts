export {};
const button = document.getElementById('uninstall') as HTMLButtonElement;
const statusMessage = document.getElementById('status')!;
button.addEventListener('click', async () => {
  button.disabled = true;
  statusMessage.textContent = '열린 관리 화면과 수집을 종료하고 데이터를 정리하고 있습니다.';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'uninstall-cleanup' });
    if (!reply?.ok) throw new Error(reply?.error || '수집 데이터 정리에 실패했습니다.');
    // Only an explicit button click reaches here. No management permission is needed for self removal.
    await chrome.management.uninstallSelf({ showConfirmDialog: false });
  } catch (error) {
    statusMessage.textContent = `${error instanceof Error ? error.message : String(error)} Chrome 확장 관리 화면에서 Video Grabber를 제거할 수도 있습니다.`;
    button.disabled = false;
  }
});
