# LEGO Model Generation, Legolization, and Assembly: A Literature Review for BrickMotion Studio

## Executive summary

The field has moved from voxel-to-brick optimization toward learned, part-aware generation. BrickGPT is the stable text-to-brick reference, but coarse: eight rectangular brick types, two rotations, no colour [1][2][3]. LEGO-Maker is evaluated only on facades/portraits and uses axis-aligned placement; LegoACE’s released model is limited to 28 brick types despite a 9,314-part corpus [10][11][12][13]. BrickNet offers thousands of LDraw part types with typed connectors; BrickWright wraps real-part assembly and validation in an agentic loop, reporting 100% valid builds on 512 prompts [4][5][6][7][8][9]. For BrickHeadz-style figures, LEGO Figurines is closest, but no paper synthesizes true SNOT; combine LEGO Figurines for portrait construction, BrickNet for part/connector vocabulary, and BrickWright/BrickLayer for validation [19][20][4][6]. For rendered build-video part identification, no paper solves the exact task; combine LTRON/BrickNet synthetic rendering, a Brickognize-style classifier, and BrickLayer validation [30][31][7][33][34].

## Scope and method

This review covers peer-reviewed papers, arXiv preprints, and official project pages from 2013 through November 2026, found through arXiv, ACM Digital Library, CVF Open Access, Eurographics, PubMed Central, and author/project sites. I prioritized work that generates or reasons about physical LEGO assemblies, and I treated “LEGO-Net” as a name-collision check rather than assuming it was a brick generator. Part vocabulary, dataset size, and release status are attributed to the source that states them; unconfirmed releases are flagged.

## 1. Foundations: voxelization, brick layout, and fabrication

**Automatic Generation of Constructable Brick Sculptures (2013).** Romain Testuz, Yuliy Schwartzburg, Mark Pauly. Eurographics 2013 Short Papers. [25] The paper voxelizes a 3D model, merges voxels into larger bricks, analyzes and repairs structural problems, and outputs building instructions. Extensions cover hollow models, brick-count limits, and colours. It frames the core legolization problem: approximate shape with real bricks while keeping the build feasible. The DOI is 10.2312/conf/EG2013/short/081-084. No public code/data found.

**Legolization: Optimizing LEGO Designs (2015).** Sheng-Jie Luo, Yonghao Yue, Chun-Kai Huang, Yu-Huan Chung, Sei Imai, Tomoyuki Nishita, Bing-Yu Chen. SIGGRAPH Asia 2015; ACM TOG 34(6), 222:1–222:12. [24] Legolization formulates design as optimization over shape fidelity, colour, and stability, then merges bricks to reduce part count. It is still a useful baseline for “brick layout optimization” because it treats stability and aesthetics as joint objectives rather than post-hoc checks. No public code/data found.

**Automatic Generation of Vivid LEGO Architectural Sculptures (2019).** J. Zhou, X. Chen, Y. Xu. Computer Graphics Forum 2019. DOI 10.1111/cgf.13603. [23] The method voxelizes, reconstructs brick blocks, deforms the layout, introduces slope and cylinder bricks, and optimizes placement. It explicitly cites Gower et al.’s 1998 six stability criteria, making it a bridge between early constructive methods and later physics-aware work. No public code/data found.

**Computational Design of LEGO Sketch Art (2023).** Mingjun Zhou, Jiahao Ge, Hao Xu, Chi-Wing Fu. ACM TOG 42(6), Article 201, 2023; SIGGRAPH Asia 2023. [21][22] This is the most relevant pre-LLM work for BrickHeadz-style detail. It uses LEGO tiles with sloping and rounding edges alongside rectangular bricks, approximates the input contour with graph optimization, then fills the contour polygon. It handles multi-colour and multi-layer regions. It is a 2D-to-relief method, not a full 3D figure generator, but its use of sloping/rounding elements is directly transferable to hair, faces, and silhouette details. No public code/data found.

## 2. Learned text/image/3D-to-brick generation

**BrickGPT / LegoGPT (2025).** “Generating Physically Stable and Buildable Brick Structures from Text.” Ava Pun, Kangle Deng, Ruixuan Liu, Deva Ramanan, Changliu Liu, Jun-Yan Zhu. ICCV 2025, pp. 14798–14809; Best Paper, Marr Prize. [1][2][3] BrickGPT fine-tunes Llama-3.2-1B-Instruct to predict the next brick as a text token, then applies validity checks and physics-aware rollback during inference. It releases StableText2Brick: over 47,000 brick structures of over 28,000 unique 3D objects with captions, plus code and model weights. The core vocabulary is eight rectangular brick types with two rotations; BrickWright’s comparison further describes it as covering 21 object categories [4]. BrickGPT is excellent for stable, simple objects and is fully reproducible, but it cannot represent slopes, SNOT, minifigures, or hair at the part level.

**LEGO-Maker (2025).** “LEGO®-Maker: Autoregressive Image-Conditioned LEGO® Model Creation.” Jiahao Ge, Mingjun Zhou, Hanyou Zheng, Hao Xu, Chi-Wing Fu. ACM TOG 44(6), Article 201, December 2025; SIGGRAPH Asia 2025. DOI 10.1145/3763285. [10][11] LEGO-Maker introduces compact brick tokenization, multi-token prediction, and a collision rollback mechanism, plus a procedural data generator and a LEGO-to-real image translator. It considers over 100 unique brick types and reports roughly 300 bricks per minute. The evaluation is limited to two categories, facade and portrait, and BrickWright characterizes the placement as axis-aligned [4]. The ACM page is open access, but I found no public code or data release; the author’s old project URL returns 404. For BrickMotion, the portrait branch is the most directly relevant learned image-to-LEGO result, but the axis-aligned constraint limits SNOT and organic hair.

**LegoACE (2025).** “LegoACE: Autoregressive Construction Engine for Expressive LEGO® Assemblies.” Hao Xu, Yuqing Zhang, Yiqian Wu, Xinyang Zheng, Yutao Liu, Xiangjun Tang, Yunhan Yang, Ding Liang, Yingtian Liu, Yuanchen Guo, Yanpei Cao, Xiaogang Jin. SIGGRAPH Asia 2025, Article 40; DOI 10.1145/3757377.3763881. [12][13][14] LegoACE is an autoregressive transformer conditioned on text or multi-view normal images. Its LegoVerse dataset contains over 55,000 models, 9,314 brick types, and 48 rotation classes. The released model, however, is restricted to a 28-brick vocabulary and 20 rotation classes; the model card explicitly lists this limitation. Code and weights are released, but the dataset/tokenizer files are not bundled with the weights. This is the strongest open, expressive assembly model, but its 28-part inference vocabulary is still far from BrickHeadz-level freedom.

**Learn to Create Simple LEGO Micro Buildings (2024).** Jiahao Ge, Mingjun Zhou, Chi-Wing Fu. ACM TOG 43(6), Article 249, December 2024; SIGGRAPH Asia 2024. DOI 10.1145/3687755. [15][16] This is the first learning-based generative pipeline for LEGO micro-buildings. It represents models as LEGO semantic volumes, trains a discrete diffusion model to generate those volumes, and uses a progressive reconstructor to place connected bricks. The dataset contains 400 models built from 28 brick types with 20 rotation types, and training code, dataset, and a pretrained model are released. It is a good reference for diffusion-based layout and connectivity, but it is single-category and low-detail.

**BrickAnything (2026).** “BrickAnything: Geometry-Conditioned Buildable Brick Generation with Structure-Aware Tokenization.” Zhengyang Ni, Feng Yan, Yu Guo, Fei Wang. NeurIPS 2026; arXiv:2605.26182. [17][18] BrickAnything conditions on a 3D mesh or point cloud and uses structure-aware tree modeling, buildability-aware preference optimization, and structural rollback. Code and model weights are released; the code uses the LDraw parts library, Michelangelo’s shape encoder, and Gurobi for stability analysis. The README does not advertise a separate dataset release or an exact part vocabulary, so it is best treated as a strong geometry-to-buildable-bricks baseline rather than a turnkey figure generator.

**Rollback-Free Stable Brick Structures Generation (2026).** Chenhui Xu, Ziyue Bai, Fuxun Yu, Heng Huang, Jinjun Xiong. arXiv:2605.06947. [36] This preprint replaces test-time rollback with reinforcement learning over assembly-level rewards for collision avoidance, connectivity, interlocking, and shape conformity. It is a useful counterpoint to BrickGPT/LEGO-Maker-style rollback: if BrickMotion needs fast batch generation, learning to avoid invalid states may be cheaper than repairing them. No public code/data found.

## 3. Part-level generation and agentic assembly

**BrickNet (2026).** “BrickNet: Graph-Backed Generative Brick Assembly.” Peter Kulits, Cordelia Schmid. CVPR 2026, pp. 39252–39261; arXiv:2604.22984. [7][8][9] BrickNet fine-tunes an LLM to generate LDraw build sequences over thousands of part types with typed connectors. Its dataset contains 320,808 samples, 9,743 unique parts, and 40.5 million placed-part instances; the SFT subset has 67,185 samples. The key idea is a graph-backed program representation: parts are nodes, connections are typed edges, and build order is a quantized spanning tree. Code and models are released, and the dataset is available by request. BrickNet is the best public source of part-level vocabulary and connectivity semantics, but its physical validity is weaker than BrickWright’s: BrickWright reports 0.318 valid builds for BrickNet versus 1.000 for BrickWright on the same 512-prompt benchmark [4].

**BrickWright (2026).** “BrickWright: Agentic Creation of Physically Feasible Brick Builds.” Ava Pun, Kevin Dai, Sally Chen, Maxwell Jones, Ruixuan Liu, Kangle Deng, Changliu Liu, Maneesh Agrawala, Deva Ramanan, Jun-Yan Zhu. arXiv:2610.31651, October 2026. [4][5][6] BrickWright gives pre-trained coding agents a Python toolkit, BrickLayer, for creating and validating builds from text or image prompts. BrickLayer exposes `search_parts`, `LegoBuild`, `Element`, `add`, `connect`, `colliding_placements`, `floating_placements`, and `connected_components`; it supports real parts including bricks, plates, tiles, slopes, inverted slopes, minifigures, doors, windows, and mirrors. On BrickNet-512, BrickWright-equipped agents achieve 1.000 valid, 1.000 collision-free, 1.000 floater-free, and 1.00 connected components; BrickGPT scores 0.990 valid and BrickNet 0.318 valid. It is the strongest current real-part feasibility baseline, and its validator is reusable as a downstream guard.

**LEGO-Net is not a brick generator.** “LEGO-Net: Learning Regular Rearrangements of Objects in Rooms,” Qiuhong Anna Wei, Sijie Ding, Jeong Joon Park, Rahul Sajnani, Adrien Poulenard, Srinath Sridhar, Leonidas Guibas, CVPR 2023. [35] Despite the name, this paper rearranges room-scale objects; it does not generate LEGO bricks. It should not be included in a brick-generation comparison except as a naming caution.

## 4. Stability and physical reasoning

**StableLego (2024).** “StableLego: Stability Analysis of Block Stacking Assembly.” Ruixuan Liu, Kangle Deng, Ziwei Wang, Changliu Liu. IEEE Robotics and Automation Letters 9(11), 9383–9390, November 2024; DOI 10.1109/LRA.2024.3414281. [26][27] StableLego formulates stability as an optimization over force-balancing equations, predicts whether a structure will stand, and locates the weakest parts. It releases code and a dataset of more than 50,000 3D objects with LEGO layouts and stability inferences. This is the most direct, reusable stability checker for generated builds; it is not a generator, and it uses a force-balancing model rather than full snap-fit/SNOT simulation.

Stability is now a first-class constraint across the field. BrickGPT filters unstable candidates and rolls back; LEGO-Maker rolls back collisions; BrickAnything uses Gurobi-based stability; BrickWright checks collisions, floaters, and connectivity. The important distinction for BrickMotion is between geometric validity (no overlaps, connected) and physical stability (will not collapse). BrickWright covers the former well; StableLego covers the latter for block-stacking layouts. A production pipeline should run both.

## 5. Assembly understanding and part recognition

**MEPNet (2022).** “Translating a Visual LEGO Manual to a Machine-Executable Plan.” Ruocheng Wang, Yunzhi Zhang, Jiayuan Mao, Chin-Yi Cheng, Jiajun Wu. ECCV 2022. [28][29] MEPNet parses 2D LEGO instruction diagrams: it detects keypoints, lifts them to 3D, and assembles a machine-executable plan. It introduces three LEGO manual datasets plus Minecraft houses, and releases code; dataset release unconfirmed. This is the core reference for instruction-manual understanding, but it assumes clean diagrammatic input rather than rendered video.

**Break and Make / LTRON (2022).** Aaron Walsman, Muru Zhang, Klemen Kotar, Karthik Desingh, Ali Farhadi, Dieter Fox. ECCV 2022; arXiv:2207.13738. [30][31] LTRON is a fully interactive 3D LEGO simulator with a fan-made dataset containing over a thousand unique brick shapes. The Break-and-Make task asks an agent to disassemble a model, then rebuild it from rendered observations using low-level actions. Code and data are released. The 2024 follow-up, “Learning to Build by Building Your Own Instructions,” adds an instruction-making agent and RC-Vehicles dataset, and improves LTRON usability [32]. LTRON is the best public source of rendered LEGO frames with part-level state for synthetic part-identification training.

**Brickognize (2023).** “Brickognize: Applying Photo-Realistic Image Synthesis for Lego Bricks Recognition with Limited Data.” Joel Vidal, Guillem Vallicrosa, Robert Martí, Marc Barnada. Sensors 23(4), 1898; DOI 10.3390/s23041898. [33][34] Brickognize combines photo-realistic synthetic images with few-shot fine-tuning from 20 real controlled images, and evaluates on controlled and uncontrolled real-world datasets. It provides a public annotated dataset and image-recognition API for parts, sets, and minifigures, with part IDs and colours. This is the closest deployed system to “identify the LEGO part in an image,” but it classifies single items, not temporal assemblies in a build video.

**Direct gap: rendered build-video part tracking.** I found no peer-reviewed paper that tracks and identifies LEGO parts from a rendered build video. The closest generic work is “Active Assembly Guidance with Online Video Parsing” (2018), which parses assembly videos with part detection, interaction recognition, and tracking, and includes a LEGO assembly example [38]. For BrickMotion, the practical approach is to generate synthetic video with LTRON or BrickNet, render segmentation/part masks, train a Brickognize-style classifier, and use BrickWright/BrickLayer for consistency checks across frames.

## 6. SNOT, slopes, and BrickHeadz-style figures

SNOT means “studs not on the top”: a part is attached sideways or upside-down, often using brackets, plates, or specialized elements. I found no peer-reviewed paper that synthesizes SNOT connections for LEGO models. A community reference defines SNOT and the common 5:2 ratio and catalogues SNOT elements [37], but it is not an academic method. The closest academic ingredients are:

- LEGO Sketch Art, which uses sloping and rounding tiles to reproduce curves and sharp features in 2D relief [21].
- LEGO Figurines, which builds coherently connected 3D figures and captures hairstyle, clothing, colour, logos, and patterns with UV-printed decals [19][20].
- BrickWright/BrickLayer, which supports real slope and inverted-slope parts and validates collisions, floaters, and connectivity [4][6].
- BrickNet, which provides thousands of LDraw part types and typed connectors, including non-brick connections, though it does not specifically evaluate SNOT [7][9].

**Creating LEGO Figurines from Single Images (2024).** Jiahao Ge, Mingjun Zhou, Wenrui Bao, Hao Xu, Chi-Wing Fu. ACM TOG 43(4), Article 153, July 2024; SIGGRAPH 2024. DOI 10.1145/3658167. [19][20] This is the most directly relevant paper for BrickHeadz-style figures. It takes a portrait photo, uses CLIP-guided retrieval to produce a physically assembleable brick figurine without decals, synthesizes decals with symmetric U-Nets, and reprojects/UV-prints them onto bricks. It evaluates against 800 expert-designed figurines and physically fabricates several results. I found no public code or dataset link, so it is a design reference rather than a turnkey pipeline. Its explicit handling of hair, clothing, and decals is exactly the detail level BrickMotion needs.

For BrickHeadz-style generation, the evidence supports a hybrid: use LEGO Figurines’ retrieval/decoration strategy for the head and torso, BrickNet’s part vocabulary and connector graph for slopes, brackets, and hair elements, BrickWright/BrickLayer for real-part feasibility, and StableLego for block-stability checks. Do not expect an end-to-end SNOT generator: that remains an open research gap.

## 7. Direct answer: best choices for the two BrickMotion use cases

### (a) Part identification from rendered build videos

There is no direct paper. The best-supported stack is:

1. **LTRON** for rendered synthetic video with part-level state and interactive assembly [30][31].
2. **BrickNet** for a large part vocabulary, connector annotations, and LDraw-native supervision [7][9].
3. **Brickognize** for the image classifier and public API pattern [33][34].
4. **BrickWright/BrickLayer** for validating that tracked parts form a feasible assembly [4][6].

A practical plan is to render BrickNet/LTRON models from many viewpoints, train a part classifier/segmenter, add temporal tracking, and use BrickLayer to reject impossible sequences. This is more defensible than claiming an existing paper solves rendered-video tracking.

### (b) BrickHeadz-style figures with slopes, SNOT, and hair

Ranked by direct usefulness:

1. **LEGO Figurines** — the only paper that directly targets personalized brick figures with hair, clothing, and decals [19][20].
2. **BrickNet** — the best part-level vocabulary and connectivity representation for slopes, brackets, and arbitrary LDraw parts [7][9].
3. **LEGO-Maker** — image-conditioned, 100+ brick types, and a portrait category; useful for the overall image-to-figure mapping, but axis-aligned and not SNOT-aware [10][11].
4. **BrickWright** — not a figure generator, but the best real-part validator and a strong agentic baseline for detailed builds [4][6].
5. **LegoACE** — expressive multi-view/text generation, but the released model’s 28-part vocabulary limits hair and SNOT detail [12][13].
6. **BrickAnything** — strong geometry-to-buildable-bricks baseline with code and weights, but no figure-specific evidence [17][18].
7. **LEGO Sketch Art** — excellent for 2D hair/face relief and sloping/rounding tiles, not full 3D figures [21].
8. **BrickGPT** — reproducible and stable, but its eight rectangular brick types are too coarse for BrickHeadz [1][3].

## 8. Practical recommendations for BrickMotion Studio

- Use BrickGPT as a stable, reproducible baseline, not as the detail model.
- Use LEGO-Maker’s portrait branch and LEGO Figurines’ retrieval/decoration pipeline as the figure-generation reference.
- Use BrickNet as the part vocabulary/connector layer and BrickWright/BrickLayer as the feasibility gate.
- Use StableLego for block-stability scoring; do not confuse it with snap-fit/SNOT mechanics.
- Treat SNOT synthesis and rendered-video part tracking as open gaps, and frame any prototype as a synthetic-data + validator pipeline rather than a solved problem.
- Prefer released assets: BrickGPT (code, weights, 47k dataset), BrickNet (code, models, dataset by request), BrickWright/BrickLayer (code), LegoACE (code, weights), Micro Buildings (code, data, weights), StableLego (code, 50k+ dataset), LTRON (code, data), MEPNet (code), Brickognize (public API). I found no public code for LEGO-Maker, LEGO Figurines, or LEGO Sketch Art.

**Overall ranked shortlist:** 1. BrickNet; 2. BrickWright/BrickLayer; 3. LEGO Figurines; 4. LEGO-Maker; 5. LegoACE; 6. StableLego; 7. LTRON; 8. Brickognize. This favors part-level representation and validation for BrickMotion’s two use cases.

## Sources

1. BrickGPT project page: https://avalovelace1.github.io/BrickGPT/
2. BrickGPT arXiv: https://arxiv.org/abs/2505.05469
3. BrickGPT code: https://github.com/AvaLovelace1/BrickGPT/
4. BrickWright project page: https://avalovelace1.github.io/brickwright/
5. BrickWright arXiv: https://arxiv.org/abs/2610.31651
6. BrickWright code: https://github.com/AvaLovelace1/brickwright
7. BrickNet project page: https://kulits.github.io/BrickNet/
8. BrickNet arXiv: https://arxiv.org/abs/2604.22984
9. BrickNet code: https://github.com/kulits/BrickNet
10. LEGO-Maker ACM page: https://dl.acm.org/doi/10.1145/3763285
11. LEGO-Maker PDF: http://unicus.cn/uploads/202602/69a107d685621.pdf
12. LegoACE project page: https://xh38.github.io/LegoACE
13. LegoACE model card: https://huggingface.co/VAST-AI/LegoACE
14. LegoACE code: https://github.com/VAST-AI-Research/LegoACE
15. Micro Buildings ACM page: https://dl.acm.org/doi/10.1145/3687755
16. Micro Buildings code/data: https://github.com/Occulte/LEGO_Buildings_Generation
17. BrickAnything arXiv: https://arxiv.org/abs/2605.26182
18. BrickAnything code: https://github.com/xjtunzy/BrickAnything
19. LEGO Figurines ACM page: https://dl.acm.org/doi/10.1145/3658167
20. LEGO Figurines project page: https://zhmjharmgal.github.io/publications/LEGO-Figurines
21. LEGO Sketch Art ACM page: https://dl.acm.org/doi/10.1145/3618306
22. LEGO Sketch Art project page: https://zhmjharmgal.github.io/publications/LEGO-Sketch-Art
23. Vivid LEGO sculptures PDF: http://staff.ustc.edu.cn/~xjchen99/2019cgf-lego-zhou.pdf
24. Legolization project page: https://www.cs.columbia.edu/~yonghao/siga15/abstsiga15.html
25. Testuz et al. DOI: https://doi.org/10.2312/conf/EG2013/short/081-084
26. StableLego arXiv: https://arxiv.org/abs/2402.10711
27. StableLego code/data: https://github.com/intelligent-control-lab/StableLego
28. MEPNet arXiv: https://arxiv.org/abs/2207.12572
29. MEPNet project page: https://cs.stanford.edu/~rcwang/projects/lego_manual/
30. LTRON / Break and Make arXiv: https://arxiv.org/abs/2207.13738
31. LTRON code: https://github.com/aaronwalsman/ltron
32. Learning to Build by Building Your Own Instructions: https://arxiv.org/abs/2410.01111
33. Brickognize paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC9967933
34. Brickognize API docs: https://api.brickognize.com/docs
35. LEGO-Net CVPR 2023: https://ivl.cs.brown.edu/research/lego-net
36. Rollback-Free Stable Brick Structures Generation: https://arxiv.org/abs/2605.06947
37. SNOT community reference: https://f005.backblazeb2.com/file/Brickshelf/bs01/gallery/joelegojoe/avatars/main.pdf
38. Active Assembly Guidance with Online Video Parsing: https://www.cs.bgu.ac.il/~asharf/Assembly.pdf
