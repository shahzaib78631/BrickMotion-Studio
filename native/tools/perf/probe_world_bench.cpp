#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include "bm/model.h"
#include "bm/collide/world.h"
using namespace bm;
int main(int argc, char** argv) {
 if(argc!=3){std::cerr<<"usage <triangles> <world-builds>\n";return 2;}
 const int tris=std::stoi(argv[1]), reps=std::stoi(argv[2]);
 const auto path=std::filesystem::temp_directory_path()/"bm-probe-bench-lib";
 std::filesystem::create_directories(path/"parts");
 {
   std::ofstream f(path/"parts"/"probe.dat");
   f<<"0 Probe benchmark triangle soup\n0 BFC CERTIFY CCW\n";
   for(int t=0;t<tris;t++){
     const int x=(t%100)*33, z=(t/100)*33, y=t%13;
     f<<"3 16 "<<x<<" "<<y<<" "<<z<<" "<<x+15<<" "<<y<<" "<<z<<" "<<x<<" "<<y<<" "<<z+15<<"\n";
   }
 }
 ldraw::Library lib(path);
 Model::Data data{{},{},{},lib,{}};
 Piece p; p.part="probe.dat";p.id="1";data.pieces.push_back(p);
 Model model(std::move(data));
 ldraw::PartCache parts(lib,path/"cache");collide::ShapeCache cache;
 auto start=std::chrono::steady_clock::now();
 collide::World first(model,parts,cache);
 auto middle=std::chrono::steady_clock::now();
 for(int i=0;i<reps;i++){ collide::World w(model,parts,cache); if(w.size()!=1)return 1; }
 auto end=std::chrono::steady_clock::now();
 std::cout<<"triangles="<<tris<<" actual="<<first.shape(0).triangles.size()/3<<" cold_ms="
 <<std::chrono::duration<double,std::milli>(middle-start).count()<<" repeated_ms="
 <<std::chrono::duration<double,std::milli>(end-middle).count()<<" rounds="<<reps<<"\n";
}
