# Multi Ask: ChatGPT & Gemini

### The Prompt

GPT coded this project, not me. Here is our conversation:

```plain
User:
请你帮我写一个 userscript 脚本，实现以下功能：
1. 这个脚本可以在任意页面运行，点击之后会帮我打开一个输入框
2. 我在这个输入框内填写内容并点击发送后，会自动帮我打开chatgpt，gemini的页面，并帮我自动的把这个问题输入并点击发送
3. 这样我就可以同时问chatgpt和gemini问题了
4. 为了实现这一点，userscript需要维护一个自己的存储（通过gm api实现），然后在打开chatgpt.com 和gemini.google.com时在url query中附带一个key，可以通过这个key从gm storage中把用户消息的内容给取出来，并自动填入到输入框中，并发送

GPT:
下面是一个完整的 userscript（适用于 Tampermonkey / Violentmonkey），满足你说的那套流程：
在任意页面右下角有一个悬浮按钮，点击后弹出输入框。
在输入框里写好问题点“发送”，脚本会：
把问题保存到 GM storage 里（带一个随机 key）；
同时打开 chatgpt.com 和 gemini.google.com/app 两个页面，并在 URL query 中带上这个 key；
当脚本在 ChatGPT / Gemini 页面检测到这个 key 时，会从 GM storage 取出问题，自动填入输入框并点击发送。
你可以直接复制下面这段脚本，新建一个 Tampermonkey 脚本粘贴保存即可：
...
```
