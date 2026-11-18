// Synthetic planner regression: identical deterministic move sequence/paths/flags
// for the original and optimized Sequencer and World implementations.
#include <chrono>
#include <filesystem>
#include <iostream>
#include <iomanip>
#include <sstream>
#include "bm/plan/plan.h"
using namespace bm;
int main(int argc,char** argv){
 if(argc!=3){std::cerr<<"usage <lib> <pieces>\n";return 2;}
 const int n=std::stoi(argv[2]);
 ldraw::Library library(argv[1]);
 Model::Data data{{},{},{},library,{}};
 for(int i=0;i<n;i++) {
  Piece p; p.id=std::to_string(i);p.part="3001.dat";p.step=i/4;
  p.world.t={42.0*(i%7), -23.0*(i/7), 0};
  data.pieces.push_back(std::move(p));
 }
 Model model(std::move(data));
 ldraw::PartCache parts(library,std::filesystem::temp_directory_path()/"bm-plan-compare-cache");
 collide::ShapeCache shapes;
 connect::Graph graph;
 graph.group.assign(n,0);
 graph.body.resize(n);for(int i=0;i<n;i++)graph.body[i]=i;
 graph.hasConnectors.assign(n,1);graph.isSegment.assign(n,0);
 // Chain connections, plus crosslinks, to require connectivity screening.
 for(int i=0;i<n;i++) for(int j=i+1;j<n;j++) {
  if(j==i+1 || (j==i+7 && i%7<6)) {
   connect::Connection c;c.a=i;c.b=j;c.joint.kind=connect::JointKind::Revolute;
   c.firstZone=graph.zones.size(); c.zoneCount=1;
   graph.zones.push_back({model.pieces()[i].world.t,model.pieces()[j].world.t,2});
   connect::Release r;r.kind=connect::ReleaseKind::Along;r.axis={0,-1,0};r.travel=0;
   graph.releases.push_back(r); graph.connections.push_back(std::move(c));
  }
 }
 graph.groups=1;graph.bodies=n;
 JobPool pool(1);
 plan::Options opt;opt.pool=&pool;
 const plan::Plan result=plan::plan(model,graph,parts,shapes,opt);
 std::ostringstream out;
 out<<std::setprecision(17);
 out<<"moves="<<result.moves.size()<<" extractions="<<result.extractions<<" complete="<<result.complete<<"\n";
 for(const auto& m:result.moves) {
  out<<m.unit.pieces.size()<<" ";for(auto p:m.unit.pieces)out<<p<<",";
  out<<" flag="<<static_cast<int>(m.flag)<<" blocker="<<m.blocker<<" source="<<static_cast<int>(m.source)<<" path="<<m.path.size()<<"\n";
  for(const auto& x:m.path) {out<<x.t.x<<","<<x.t.y<<","<<x.t.z<<" ";for(double d:x.r.m)out<<d<<",";out<<"\n";}
 }
 std::cout<<out.str();
}
