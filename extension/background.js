// The toolbar icon opens the wallet in the side panel, which stays open while
// a deposit or payment runs (a popup would close on the first click outside
// it, and take the payment with it). A browser without side panels gets the
// wallet in a tab instead.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'app.html' }));
}
