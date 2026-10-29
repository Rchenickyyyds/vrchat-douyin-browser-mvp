export class DouyinController {
  constructor(page, selectors) {
    this.page = page;
    this.selectors = selectors;
  }

  async next() {
    await this.pressFirstWorkingKey(this.selectors.nextKeys);
  }

  async prev() {
    await this.pressFirstWorkingKey(this.selectors.prevKeys);
  }

  async like() {
    await this.clickFirstVisible(this.selectors.like, "点赞");
  }

  async favorite() {
    await this.clickFirstVisible(this.selectors.favorite, "收藏");
  }

  async pressFirstWorkingKey(keys) {
    await this.page.bringToFront();
    let lastError;
    for (const key of keys) {
      try {
        await this.page.keyboard.press(key);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("no navigation key configured");
  }

  async clickFirstVisible(selectors, label) {
    await this.page.bringToFront();
    for (const selector of selectors) {
      const candidates = this.page.locator(selector);
      for (let index = (await candidates.count()) - 1; index >= 0; index--) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible()) {
          await candidate.click({ timeout: 3000 });
          return;
        }
      }
    }
    throw new Error(`找不到当前视频的${label}按钮，请更新 config/selectors.json`);
  }
}
