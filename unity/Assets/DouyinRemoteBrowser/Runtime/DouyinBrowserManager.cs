using UdonSharp;
using UnityEngine;
using VRC.SDK3.Components.Video;
using VRC.SDK3.Video.Components.AVPro;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class DouyinBrowserManager : UdonSharpBehaviour
{
    private const float VIDEO_REQUEST_COOLDOWN = 5.2f;
    private const float VIDEO_RETRY_DELAY = 6f;
    private const int MAX_AUTOMATIC_RETRIES = 3;

    [Header("本地播放器引用（不创建或控制服务器 Session）")]
    public BrowserSlotUrls slotUrls;
    public VRCAVProVideoPlayer videoPlayer;
    public DouyinBrowserUI ui;

    [HideInInspector] public bool localPlaybackRequested;
    [HideInInspector] public bool localPlaying;
    [HideInInspector] public string currentStatus = "请粘贴授权控制端提供的短期观看 URL";

    private VRCUrl currentStreamUrl = VRCUrl.Empty;
    private float nextVideoLoadTime;
    private float retryAt;
    private int automaticRetries;
    private bool retryPending;

    private void Start()
    {
        RefreshUi();
    }

    private void Update()
    {
        if (!localPlaybackRequested || !retryPending || Time.realtimeSinceStartup < retryAt) return;
        retryPending = false;
        LoadCurrentStream();
    }

    public void PlayEnteredStream()
    {
        if (localPlaybackRequested) return;
        if (slotUrls == null || videoPlayer == null)
        {
            SetStatus("播放器或 URL 输入组件尚未接线");
            return;
        }
        if (Time.realtimeSinceStartup < nextVideoLoadTime)
        {
            SetStatus("视频 URL 加载冷却中，请稍后再试");
            return;
        }

        VRCUrl requestedUrl = slotUrls.GetStreamUrl();
        if (VRCUrl.IsNullOrEmpty(requestedUrl) || !requestedUrl.Get().StartsWith("https://"))
        {
            SetStatus("请粘贴完整的 HTTPS 观看 URL");
            return;
        }

        currentStreamUrl = requestedUrl;
        automaticRetries = 0;
        retryPending = false;
        localPlaybackRequested = true;
        LoadCurrentStream();
    }

    public void StopPlayback()
    {
        localPlaybackRequested = false;
        localPlaying = false;
        retryPending = false;
        currentStreamUrl = VRCUrl.Empty;
        if (videoPlayer != null) videoPlayer.Stop();
        if (slotUrls != null) slotUrls.ClearInput();
        SetStatus("已停止本地播放并清空输入；服务器 Session 由授权控制端管理");
    }

    private void LoadCurrentStream()
    {
        if (!localPlaybackRequested || VRCUrl.IsNullOrEmpty(currentStreamUrl)) return;
        nextVideoLoadTime = Time.realtimeSinceStartup + VIDEO_REQUEST_COOLDOWN;
        localPlaying = false;
        SetStatus("正在加载本地视频流");
        videoPlayer.PlayURL(currentStreamUrl);
    }

    public override void OnVideoReady()
    {
        if (localPlaybackRequested) videoPlayer.Play();
    }

    public override void OnVideoStart()
    {
        if (!localPlaybackRequested) return;
        localPlaying = true;
        retryPending = false;
        SetStatus("正在本地播放；此 URL 持有者可以观看并转发链接");
    }

    public override void OnVideoEnd()
    {
        if (!localPlaybackRequested) return;
        localPlaybackRequested = false;
        localPlaying = false;
        retryPending = false;
        currentStreamUrl = VRCUrl.Empty;
        SetStatus("视频流已结束；请向授权控制端确认 Session 和观看链接状态");
    }

    public override void OnVideoError(VideoError videoError)
    {
        if (!localPlaybackRequested || retryPending) return;
        localPlaying = false;
        if (automaticRetries >= MAX_AUTOMATIC_RETRIES)
        {
            localPlaybackRequested = false;
            currentStreamUrl = VRCUrl.Empty;
            videoPlayer.Stop();
            SetStatus("播放失败，已达到自动重试上限；请检查链接有效期和客户端 URL 设置");
            return;
        }

        automaticRetries++;
        retryPending = true;
        retryAt = Time.realtimeSinceStartup + VIDEO_RETRY_DELAY;
        if (retryAt < nextVideoLoadTime) retryAt = nextVideoLoadTime;
        SetStatus("视频加载失败，等待自动重试（" + automaticRetries + "/" + MAX_AUTOMATIC_RETRIES + "）");
    }

    private void OnDisable()
    {
        StopPlayback();
    }

    private void SetStatus(string value)
    {
        currentStatus = value;
        RefreshUi();
    }

    private void RefreshUi()
    {
        if (ui != null) ui.Refresh();
    }
}
