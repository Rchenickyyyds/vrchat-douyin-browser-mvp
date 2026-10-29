using UdonSharp;
using UnityEngine;
using UnityEngine.UI;

public class DouyinBrowserUI : UdonSharpBehaviour
{
    public DouyinBrowserManager manager;

    [Header("状态文字")]
    public Text browserText;
    public Text profileText;
    public Text controllerText;
    public Text slotText;
    public Text statusText;

    [Header("按钮（用于自动设置 interactable）")]
    public Button initializeButton;
    public Button getControlButton;
    public Button previousButton;
    public Button nextButton;
    public Button likeButton;
    public Button favoriteButton;

    private void Start()
    {
        Refresh();
    }

    public void Refresh()
    {
        if (manager == null) return;
        browserText.text = "浏览器：" + (manager.browserInitialized ? "已启动" : "未初始化");
        profileText.text = "当前 Profile：" + ProfileLabel();
        controllerText.text = "当前控制者：" + (manager.controllerPlayerId == -1 ? "无" : manager.controllerDisplayName);
        slotText.text = "Slot：" + (manager.slotId < 0 ? "-" : manager.slotId.ToString());
        statusText.text = "状态：" + manager.currentStatus;

        bool canControl = manager.IsLocalController() && !manager.localRequestInFlight;
        initializeButton.interactable = !manager.browserInitialized && !manager.localRequestInFlight;
        getControlButton.interactable = manager.browserInitialized && manager.controllerPlayerId == -1;
        previousButton.interactable = canControl;
        nextButton.interactable = canControl;
        likeButton.interactable = canControl;
        favoriteButton.interactable = canControl;
    }

    public void InitializeBrowser() { manager.InitializeBrowser(); }
    public void GetControl() { manager.GetControl(); }
    public void Previous() { manager.Previous(); }
    public void Next() { manager.Next(); }
    public void Like() { manager.Like(); }
    public void Favorite() { manager.Favorite(); }

    private string ProfileLabel()
    {
        if (!manager.browserInitialized && manager.profileType < 0) return "-";
        if (manager.profileType == BrowserSlotUrls.PROFILE_USER_1) return "User1";
        if (manager.profileType == BrowserSlotUrls.PROFILE_USER_2) return "User2";
        return "Guest";
    }
}
