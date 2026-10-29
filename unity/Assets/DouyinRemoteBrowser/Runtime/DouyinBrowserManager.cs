using UdonSharp;
using UnityEngine;
using VRC.SDK3.Components.Video;
using VRC.SDK3.StringLoading;
using VRC.SDK3.Video.Components.AVPro;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
public class DouyinBrowserManager : UdonSharpBehaviour
{
    // 第一版身份配置：只改这里。
    public const string VRC_USER_1 = "Example User One";
    public const string VRC_USER_2 = "Example User Two";

    private const float STRING_REQUEST_COOLDOWN = 5.2f;
    private const float HEARTBEAT_INTERVAL = 30f;
    private const float VIDEO_RETRY_DELAY = 6f;

    [Header("场景引用")]
    public BrowserSlotUrls slotUrls;
    public VRCAVProVideoPlayer videoPlayer;
    public DouyinBrowserUI ui;

    [UdonSynced] public bool browserInitialized;
    [UdonSynced] public int slotId = -1;
    [UdonSynced] public int profileType = -1;
    [UdonSynced] public int controllerPlayerId = -1;
    [UdonSynced] public string controllerDisplayName = "";
    [UdonSynced] public string currentStatus = "未初始化";

    [HideInInspector] public bool localRequestInFlight;

    private int pendingProfileType = -1;
    private string pendingLabel = "";
    private float nextStringRequestTime;
    private float nextHeartbeatTime;
    private float nextVideoLoadTime;
    private int playingSlot = -1;
    private int videoRetryCount;
    private bool videoRetryScheduled;

    private void Start()
    {
        RefreshUi();
        ApplySyncedState();
    }

    private void Update()
    {
        if (!browserInitialized || !Networking.IsOwner(gameObject) || localRequestInFlight) return;
        if (Time.realtimeSinceStartup < nextHeartbeatTime) return;
        SendStringRequest(slotUrls.heartbeatUrls[slotId], "心跳");
    }

    public void InitializeBrowser()
    {
        if (browserInitialized || localRequestInFlight || Networking.LocalPlayer == null) return;
        pendingProfileType = ProfileForDisplayName(Networking.LocalPlayer.displayName);
        Networking.SetOwner(Networking.LocalPlayer, gameObject);
        SendCustomEventDelayedFrames(nameof(BeginInitializationAsOwner), 2);
    }

    public void BeginInitializationAsOwner()
    {
        if (browserInitialized || localRequestInFlight || !Networking.IsOwner(gameObject)) return;
        controllerPlayerId = Networking.LocalPlayer.playerId;
        controllerDisplayName = Networking.LocalPlayer.displayName;
        currentStatus = "正在初始化服务器端 Chromium";
        profileType = pendingProfileType;
        RequestSerialization();
        RefreshUi();
        SendStringRequest(slotUrls.GetCreateUrl(pendingProfileType), "初始化");
    }

    public void GetControl()
    {
        if (!browserInitialized || controllerPlayerId != -1 || Networking.LocalPlayer == null) return;
        Networking.SetOwner(Networking.LocalPlayer, gameObject);
        SendCustomEventDelayedFrames(nameof(AcquireControlAsOwner), 2);
    }

    public void AcquireControlAsOwner()
    {
        if (!browserInitialized || controllerPlayerId != -1 || !Networking.IsOwner(gameObject)) return;
        controllerPlayerId = Networking.LocalPlayer.playerId;
        controllerDisplayName = Networking.LocalPlayer.displayName;
        currentStatus = "运行中";
        RequestSerialization();
        RefreshUi();
    }

    public void Previous()
    {
        SendControlAction(0, "上一条");
    }

    public void Next()
    {
        SendControlAction(1, "下一条");
    }

    public void Like()
    {
        SendControlAction(2, "点赞");
    }

    public void Favorite()
    {
        SendControlAction(3, "收藏");
    }

    private void SendControlAction(int action, string label)
    {
        if (!IsLocalController())
        {
            currentStatus = "只有当前控制者可以操作";
            RefreshUi();
            return;
        }
        SendStringRequest(slotUrls.GetActionUrl(slotId, action), label);
    }

    private void SendStringRequest(VRCUrl url, string label)
    {
        if (localRequestInFlight) return;
        if (Time.realtimeSinceStartup < nextStringRequestTime)
        {
            currentStatus = "VRChat URL 限速，请稍后再试";
            RefreshUi();
            return;
        }
        if (VRCUrl.IsNullOrEmpty(url))
        {
            currentStatus = "Slot URL 未配置";
            RefreshUi();
            return;
        }

        localRequestInFlight = true;
        pendingLabel = label;
        nextStringRequestTime = Time.realtimeSinceStartup + STRING_REQUEST_COOLDOWN;
        nextHeartbeatTime = Time.realtimeSinceStartup + HEARTBEAT_INTERVAL;
        VRCStringDownloader.LoadUrl(url, this);
        RefreshUi();
    }

    public override void OnStringLoadSuccess(IVRCStringDownload result)
    {
        localRequestInFlight = false;
        int createdProfile = slotUrls.GetCreateProfileType(result.Url);
        if (createdProfile >= 0)
        {
            int createdSlot;
            if (!int.TryParse(result.Result.Trim(), out createdSlot) || createdSlot < 0 || createdSlot >= BrowserSlotUrls.SLOT_COUNT)
            {
                FailInitialization("初始化返回了无效 Slot");
                return;
            }

            browserInitialized = true;
            slotId = createdSlot;
            profileType = createdProfile;
            controllerPlayerId = Networking.LocalPlayer.playerId;
            controllerDisplayName = Networking.LocalPlayer.displayName;
            currentStatus = "浏览器已启动，等待视频流";
            RequestSerialization();
            ApplySyncedState();
            return;
        }

        if (pendingLabel != "心跳") SetOwnerStatus(pendingLabel + "：成功");
        else RefreshUi();
    }

    public override void OnStringLoadError(IVRCStringDownload result)
    {
        localRequestInFlight = false;
        string message = pendingLabel + "失败（HTTP " + result.ErrorCode + "）：" + result.Error;
        if (pendingLabel == "初始化" && !browserInitialized) FailInitialization(message);
        else SetOwnerStatus(message);
    }

    public override void OnDeserialization()
    {
        ApplySyncedState();
    }

    public override void OnPlayerLeft(VRCPlayerApi player)
    {
        if (player.playerId != controllerPlayerId || !Networking.IsOwner(gameObject)) return;
        controllerPlayerId = -1;
        controllerDisplayName = "";
        currentStatus = "控制者已离开，可获取控制权";
        RequestSerialization();
        RefreshUi();
    }

    public override bool OnOwnershipRequest(VRCPlayerApi requester, VRCPlayerApi newOwner)
    {
        return controllerPlayerId == -1 || (Utilities.IsValid(newOwner) && newOwner.playerId == controllerPlayerId);
    }

    public override void OnOwnershipTransferred(VRCPlayerApi player)
    {
        if (Networking.IsOwner(gameObject)) nextHeartbeatTime = Time.realtimeSinceStartup;
        RefreshUi();
    }

    public override void OnVideoReady()
    {
        videoPlayer.Play();
    }

    public override void OnVideoStart()
    {
        videoRetryCount = 0;
        videoRetryScheduled = false;
        RefreshUi();
    }

    public override void OnVideoError(VideoError videoError)
    {
        if (!browserInitialized || videoRetryScheduled || videoRetryCount >= 10) return;
        videoRetryCount++;
        videoRetryScheduled = true;
        SendCustomEventDelayedSeconds(nameof(RetryStream), VIDEO_RETRY_DELAY);
    }

    public void RetryStream()
    {
        videoRetryScheduled = false;
        PlayCurrentStream();
    }

    public void PlayCurrentStream()
    {
        if (!browserInitialized || slotId < 0 || slotId >= BrowserSlotUrls.SLOT_COUNT) return;
        if (Time.realtimeSinceStartup < nextVideoLoadTime)
        {
            if (!videoRetryScheduled)
            {
                videoRetryScheduled = true;
                SendCustomEventDelayedSeconds(nameof(RetryStream), VIDEO_RETRY_DELAY);
            }
            return;
        }

        videoRetryScheduled = false;
        nextVideoLoadTime = Time.realtimeSinceStartup + STRING_REQUEST_COOLDOWN;
        playingSlot = slotId;
        videoPlayer.Stop();
        videoPlayer.PlayURL(slotUrls.streamUrls[slotId]);
    }

    public bool IsLocalController()
    {
        return browserInitialized && Networking.LocalPlayer != null &&
               Networking.LocalPlayer.playerId == controllerPlayerId;
    }

    private int ProfileForDisplayName(string displayName)
    {
        if (displayName == VRC_USER_1) return BrowserSlotUrls.PROFILE_USER_1;
        if (displayName == VRC_USER_2) return BrowserSlotUrls.PROFILE_USER_2;
        return BrowserSlotUrls.PROFILE_GUEST;
    }

    private void ApplySyncedState()
    {
        RefreshUi();
        if (browserInitialized && playingSlot != slotId) PlayCurrentStream();
    }

    private void SetOwnerStatus(string value)
    {
        currentStatus = value;
        if (Networking.IsOwner(gameObject)) RequestSerialization();
        RefreshUi();
    }

    private void FailInitialization(string value)
    {
        profileType = -1;
        controllerPlayerId = -1;
        controllerDisplayName = "";
        SetOwnerStatus(value);
    }

    private void RefreshUi()
    {
        if (ui != null) ui.Refresh();
    }
}
