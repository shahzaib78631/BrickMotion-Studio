# Batman (40859) placed by hand from the booklet. LDraw units: X right, Y down, Z front.
# Figure grid: x studs 0..4 left->right, z 0..4 back->front, y plates up (X=20x, Y=-8y, Z=20z).
import sys

I   = (1,0,0, 0,1,0, 0,0,1)
R180= (-1,0,0, 0,1,0, 0,0,-1)        # upright, turned 180 (side studs face front)
RZ  = (0,0,1, 0,1,0, -1,0,0)         # upright, length along z; side studs face -x
RZR = (0,0,-1, 0,1,0, 1,0,0)         # upright, length along z; side studs face +x
FRONT = (1,0,0, 0,0,1, 0,-1,0)       # top faces +z (front), length along x
BACK  = (1,0,0, 0,0,-1, 0,1,0)       # top faces -z (back), length along x, local -z points down
LEFT  = (0,1,0, 0,0,1, 1,0,0)        # top faces -x, length along z, local +z points down
LEFT_CLIPDOWN = (0,1,0, 0,0,-1, -1,0,0)
RIGHT = (0,-1,0, 0,0,-1, 1,0,0)      # top faces +x, length along z
RIGHT_CLIPDOWN = (0,-1,0, 0,0,-1, 1,0,0)
RIGHT_ZDOWN = (0,-1,0, 0,0,1, -1,0,0)  # top faces +x, local +z points down
LEFT_VERT  = (0,1,0, 1,0,0, 0,0,-1)  # top faces -x, length (local x) vertical
RIGHT_VERT = (0,-1,0, 1,0,0, 0,0,1)
LEFT_TOOTHDOWN  = (0,1,0, 0,0,-1, -1,0,0)
RIGHT_TOOTHDOWN = (0,-1,0, 0,0,-1, 1,0,0)
BACK_UP = (1,0,0, 0,0,-1, 0,1,0)     # top faces -z, local +z points up? (checked by render)
TILE23_L = (0,1,0, 1,0,0, 0,0,-1)    # 2x3 tile on left side, 3 long vertical
TILE23_R = (0,-1,0, 1,0,0, 0,0,1)

BLACK, BLUE, RED, YELLOW, WHITE, LBG, DBG, GREEN = 0, 1, 4, 14, 15, 71, 72, 2
NOUGAT, PINK, AZURE, GOLD = 78, 29, 322, 297

steps = []
def step(*pieces): steps.append(pieces)
def p(part, color, x, y, z, m=I): return (part, color, x, y, z, m)

# torso
step(p('3031', BLACK, 40, -8, 40), p('3710', YELLOW, 70, -16, 40, RZ))                       # 1
step(p('3710', YELLOW, 10, -16, 40, RZ))                                                       # 2
step(p('3022', BLACK, 40, 0, 40), p('28653', LBG, 10, 0, 40, RZ), p('28653', LBG, 70, 0, 40, RZ))  # 3 (under base)
step(p('28653', LBG, 40, -16, 30), p('28802', BLACK, 40, -16, 10))                            # 4
step(p('3024', YELLOW, 10, -24, 70), p('3024', YELLOW, 70, -24, 70), p('4304', BLUE, 40, -24, 70, R180))  # 5
step(p('3021', GREEN, 40, -24, 30, RZ))                                                        # 6
step(p('3004', BLUE, 40, -24, 10), p('3941', RED, 40, -24, 40))                                # 7
step(p('93274', BLUE, 40, -56, 10), p('14769', GOLD, 40, -56, 40))                             # 8
step(p('32952', AZURE, 10, -56, 10, RZ), p('32952', AZURE, 70, -56, 10, RZR),
     p('22885', DBG, 10, -56, 40, RZ), p('22885', DBG, 70, -56, 40, RZR))                     # 9
step(p('3710', LBG, 40, -32, 70), p('3010', LBG, 40, -56, 70))                                 # 10
step(p('96910', YELLOW, 40, -18, 88, FRONT))                                                   # 11
step(p('3031', BLUE, 40, -64, 40))                                                             # 12
# arms (sub-build x2): grey 2x2 plate, grey chamfered tile on the upper row, clip + teeth on the lower row
step(p('3022', LBG, -8, -36, 40, LEFT), p('96910', LBG, -16, -46, 40, LEFT),
     p('11476', BLUE, -16, -26, 40, LEFT_CLIPDOWN), p('15208', BLUE, -24, -26, 40, LEFT),
     p('3022', LBG, 88, -36, 40, RIGHT), p('96910', LBG, 96, -46, 40, RIGHT),
     p('11476', BLUE, 96, -26, 40, RIGHT_CLIPDOWN), p('15208', BLUE, 104, -26, 40, RIGHT_ZDOWN))  # 13
# head core
step(p('3003', GREEN, 40, -88, 40), p('3003', GREEN, 40, -112, 40))                           # 14
step(p('22885', DBG, 20, -104, 10), p('22885', DBG, 60, -104, 10),
     p('22885', DBG, 20, -104, 70, R180), p('22885', DBG, 60, -104, 70, R180),
     p('22885', DBG, 10, -104, 40, RZ), p('22885', DBG, 70, -104, 40, RZR))                   # 15
step(p('4032a', DBG, 40, -120, 40), p('3003', PINK, 40, -144, 40))                             # 16
step(p('22885', DBG, 40, -144, 70, R180), p('22885', DBG, 40, -144, 10),
     p('22885', DBG, 10, -144, 20, RZ), p('22885', DBG, 10, -144, 60, RZ),
     p('22885', DBG, 70, -144, 20, RZR), p('22885', DBG, 70, -144, 60, RZR))                  # 17
step(p('3031', BLUE, 40, -152, 40))                                                            # 18
# legs: grey + blue + blue under the step-3 grey plates
step(*[p('28653', c, x, y, 40, RZ) for x in (10, 70) for c, y in ((LBG, 8), (BLUE, 16), (BLUE, 24))])  # 19
# face on the front side studs
step(p('3020', BLACK, 40, -104, 88, FRONT), p('41740', BLACK, 40, -134, 88, FRONT), p('3710', NOUGAT, 40, -74, 88, FRONT))  # 20
step(p('41740', BLACK, 40, -94, 96, FRONT), p('2431', NOUGAT, 40, -74, 96, FRONT), p('87079', BLACK, 40, -124, 96, FRONT))  # 21
step(p('24246', WHITE, 10, -94, 104, FRONT), p('24246', WHITE, 70, -94, 104, FRONT))           # 22
# left side of head
step(p('2431', BLUE, -8, -74, 40, LEFT), p('26603', BLUE, -8, -114, 60, TILE23_L))            # 23
step(p('3022', BLUE, -8, -124, 20, LEFT), p('29120', BLUE, -8, -144, 10, LEFT), p('29119', BLUE, -8, -144, 30, LEFT),
     p('7302', BLUE, -24, -94, 10, LEFT), p('7302', BLUE, -24, -94, 30, LEFT))                # 24 left ear
step(p('32028', BLUE, -8, -36, 10, LEFT_VERT), p('3024', BLUE, -16, -46, 10, LEFT),
     p('49668', BLUE, -16, -26, 10, LEFT_TOOTHDOWN), p('7302', BLUE, -32, -26, 10, LEFT))     # 25 left cape side
step(p('3031', BLUE, 40, -104, -8, BACK), p('87079', BLUE, 40, -124, -16, BACK), p('87079', BLUE, 40, -84, -16, BACK))  # 26 back of head
step(*[p('49668', BLUE, x, -6, -12, BACK) for x in (10, 30, 50, 70)])                          # 27 cape bottom
step(*[p('7302', BLUE, x, -26, -28, BACK_UP) for x in (10, 30, 50, 70)])                       # 28 cape
step(p('2431', BLUE, 88, -74, 40, RIGHT), p('26603', BLUE, 88, -114, 60, TILE23_R))           # 29
step(p('3022', BLUE, 88, -124, 20, RIGHT), p('29119', BLUE, 88, -144, 10, RIGHT_ZDOWN), p('29120', BLUE, 88, -144, 30, RIGHT_ZDOWN),
     p('7302', BLUE, 104, -94, 10, RIGHT_ZDOWN), p('7302', BLUE, 104, -94, 30, RIGHT_ZDOWN))  # 30 right ear
step(p('32028', BLUE, 88, -36, 10, RIGHT_VERT), p('3024', BLUE, 96, -46, 10, RIGHT),
     p('49668', BLUE, 96, -26, 10, RIGHT_TOOTHDOWN), p('7302', BLUE, 112, -26, 10, RIGHT_ZDOWN))  # 31 right cape side
step(p('3958', BLACK, 40, 40, 40), p('87079', BLACK, 40, 32, 20), p('41740', BLACK, 40, 32, 50), p('2431', BLACK, 40, 32, 70))  # 32 stand

def fmt(v): return str(int(v)) if float(v).is_integer() else f'{v:g}'
out = ['0 FILE 40859-batman.ldr', '0 40859 Batman (hand-placed from booklet 6668732)', '0 Name: 40859-batman.ldr', '0 Author: BrickMotion', '']
for i, pieces in enumerate(steps, 1):
    out.append(f'0 // step {i}')
    for part, c, x, y, z, m in pieces:
        # turn the figure 180 degrees about Y (centred on the base) so its face points to LDraw front (-Z)
        x, z = 80 - x, 80 - z
        m = tuple(-v if i < 3 or i >= 6 else v for i, v in enumerate(m))
        out.append(f'1 {c} {fmt(x)} {fmt(y)} {fmt(z)} ' + ' '.join(fmt(v) for v in m) + f' {part}.dat')
    out.append('0 STEP')
open(sys.argv[1], 'w').write('\n'.join(out) + '\n')
print(len(steps), 'steps', sum(len(s) for s in steps), 'pieces')
