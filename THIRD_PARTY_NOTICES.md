# Third-Party Notices

The PolyForm Noncommercial restriction covers original DSH Toolbox code only. It does not relicense third-party packages, trademarks, documentation, or other materials.

DSH Toolbox is an independent project built for DeepSeek Harness. DeepSeek Harness and its Cordis/tool packages are maintained by their respective copyright holders and distributed under their own terms.

Implementation patterns were studied from publicly visible DSH plugins including `dsh-openapi` and `dsh-context-doctor`. No source code from those projects is copied into this repository.

[CC Switch](https://github.com/farion1231/cc-switch) was studied as product and architecture inspiration for provider/profile discovery, explicit switching, backup, and local desktop management. CC Switch is MIT-licensed. DSH Switchboard is an independent implementation and currently copies no CC Switch source code or assets. If CC Switch code is incorporated later, its MIT copyright and license notice must be added here and shipped with every affected distribution; the inherited MIT permission cannot be narrowed retroactively by this repository's noncommercial license.

OpenCode Dynamic Context Pruning and other agent plugins may be referenced as product inspiration only. Code from repositories without a compatible license, including AGPL code, must not be copied or incorporated without a documented license decision.

Each plugin currently depends at runtime on `@deepseek-ai/dsh-tools@0.1.1-rc.2` and declares `@deepseek-ai/cordis^4.0.1` as a peer dependency. Those packages and their transitive dependencies retain their own licenses and notices. Review the packed dependency tree and include any notices required by those terms before redistributing a bundled dependency archive.

The DSH Switchboard GUI directly bundles the following frontend assets/runtime code under their original licenses:

- Inter font files from `@fontsource/inter`, under the SIL Open Font License 1.1;
- Bootstrap Icons font/CSS, under the MIT License;
- React and React DOM runtime code, under the MIT License.

The corresponding license texts are included in [`packages/dsh-switchboard-gui/third-party-licenses`](packages/dsh-switchboard-gui/third-party-licenses). Vite and `@vitejs/plugin-react` are build-time development dependencies and remain under their own MIT licenses.
